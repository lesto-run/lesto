import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CollectedFile } from "./collector";
import type { Document, DocumentMeta, CollectionSchema } from "./types";
import { ValidationError } from "./types";
import { resolveParser, isValidPreset } from "@lesto/content-umbra";
import type { CacheManager } from "./cache";
import { createSyncHasher } from "./cache";
import { createWorkerPool, type WorkerPool } from "./workers";

export interface ParsedDocument {
  file: CollectedFile;
  document: Document;
  slug: string;
  /** Whether this is an MDX file */
  isMDX: boolean;
}

export interface ParseResult {
  documents: ParsedDocument[];
  errors: ValidationError[];
}

function buildMeta(relativePath: string): DocumentMeta {
  const parsed = path.parse(relativePath);
  const isIndex = parsed.name === "index" || parsed.name.toLowerCase() === "readme";

  // Build path segments from the slug (which is the semantic path)
  // For index files, use directory segments; for regular files, include filename
  const segments = parsed.dir ? parsed.dir.split(path.sep) : [];
  const pathSegments = isIndex ? segments : [...segments, parsed.name];

  return {
    path: relativePath,
    fileName: parsed.name,
    extension: parsed.ext.slice(1),
    directory: parsed.dir || ".",
    pathSegments,
    isIndex,
  };
}

function deriveSlug(relativePath: string): string {
  const parsed = path.parse(relativePath);

  if (parsed.name === "index") {
    const dir = parsed.dir;
    if (!dir || dir === ".") return "index";
    return dir.split(path.sep).pop()!;
  }

  return relativePath
    .replace(/\.[^.]+$/, "")
    .split(path.sep)
    .join("/");
}

async function validateSchema(
  schema: CollectionSchema,
  data: unknown,
  filePath: string,
  collection: string,
): Promise<Record<string, unknown>> {
  const result = schema["~standard"].validate(data);
  const resolved = result instanceof Promise ? await result : result;

  if (resolved.issues) {
    throw new ValidationError(
      resolved.issues.map((issue) => {
        const base: { message: string; path?: readonly PropertyKey[] } = {
          message: issue.message,
        };
        if (issue.path) {
          base.path = issue.path as readonly PropertyKey[];
        }
        return base;
      }),
      filePath,
      collection,
    );
  }

  return resolved.value as Record<string, unknown>;
}

async function parseContent(
  file: CollectedFile,
  content: string,
  workerPool?: WorkerPool,
): Promise<{ rawData: unknown; body: string }> {
  if (
    workerPool &&
    typeof file.collection.parser === "string" &&
    isValidPreset(file.collection.parser)
  ) {
    try {
      const result = await workerPool.execute({
        content,
        filePath: file.absolutePath,
        parserName: file.collection.parser,
      });
      return { rawData: result.data, body: result.content };
    } catch {
      // Fall through to direct parsing
    }
  }

  const parser = resolveParser(file.collection.parser);
  const parseResult = parser.parse(content, file.absolutePath);
  return { rawData: parseResult.data, body: parseResult.content };
}

function buildParsedDocument(
  file: CollectedFile,
  data: Record<string, unknown>,
  body: string,
  meta: DocumentMeta,
  slug: string,
  isMDX: boolean,
): ParsedDocument {
  return {
    file,
    document: { data, content: body, file: meta },
    slug,
    isMDX,
  };
}

async function parseFile(
  file: CollectedFile,
  cache?: CacheManager,
  syncHasher?: ReturnType<typeof createSyncHasher>,
  workerPool?: WorkerPool,
): Promise<ParsedDocument> {
  let content: string;
  try {
    content = await readFile(file.absolutePath, "utf-8");
  } catch (err) {
    // File may have been deleted between collection and parsing (watch mode race condition)
    throw new Error(
      `Failed to read file "${file.absolutePath}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const ext = path.extname(file.absolutePath).toLowerCase();
  const isMDX = ext === ".mdx";

  if (cache && syncHasher) {
    const contentHash = syncHasher.hash(content);
    const cached = cache.getParseCache(file.collection.name, file.relativePath, contentHash);

    if (cached) {
      return buildParsedDocument(
        file,
        cached.data,
        cached.content,
        cached.meta,
        cached.slug,
        isMDX,
      );
    }

    const { rawData, body } = await parseContent(file, content, workerPool);
    const data = await validateSchema(
      file.collection.schema,
      rawData,
      file.absolutePath,
      file.collection.name,
    );

    const meta = buildMeta(file.relativePath);
    const slug = deriveSlug(file.relativePath);

    cache.setParseCache(file.collection.name, file.relativePath, {
      contentHash,
      data,
      content: body,
      slug,
      meta,
    });

    return buildParsedDocument(file, data, body, meta, slug, isMDX);
  }

  const { rawData, body } = await parseContent(file, content, workerPool);
  const data = await validateSchema(
    file.collection.schema,
    rawData,
    file.absolutePath,
    file.collection.name,
  );

  const meta = buildMeta(file.relativePath);
  const slug = deriveSlug(file.relativePath);

  return buildParsedDocument(file, data, body, meta, slug, isMDX);
}

export interface ParseOptions {
  cache?: CacheManager;
  useWorkers?: boolean;
}

export async function parse(
  files: CollectedFile[],
  optionsOrCache?: ParseOptions | CacheManager,
): Promise<ParseResult> {
  let cache: CacheManager | undefined;
  let useWorkers: boolean;

  if (optionsOrCache && "init" in optionsOrCache && "flush" in optionsOrCache) {
    cache = optionsOrCache as CacheManager;
    useWorkers = files.length > 50;
  } else {
    const options = optionsOrCache as ParseOptions | undefined;
    cache = options?.cache;
    useWorkers = options?.useWorkers ?? files.length > 50;
  }

  const syncHasher = cache ? createSyncHasher() : undefined;
  let workerPool: WorkerPool | undefined;

  try {
    if (useWorkers) {
      try {
        workerPool = createWorkerPool();
      } catch (err) {
        // Log worker pool creation failures to aid debugging
        console.warn(
          `[docks] Worker pool creation failed, falling back to single-threaded parsing: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const results = await Promise.allSettled(
      files.map((file) => parseFile(file, cache, syncHasher, workerPool)),
    );

    const documents: ParsedDocument[] = [];
    const errors: ValidationError[] = [];

    for (const result of results) {
      if (result.status === "fulfilled") {
        documents.push(result.value);
      } else if (result.reason instanceof ValidationError) {
        errors.push(result.reason);
      } else {
        throw result.reason;
      }
    }

    return { documents, errors };
  } finally {
    if (workerPool) {
      await workerPool.shutdown();
    }
  }
}

export async function parseOne(file: CollectedFile): Promise<ParsedDocument> {
  return parseFile(file);
}
