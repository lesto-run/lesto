import os from "node:os";
import path from "node:path";
import pLimit from "p-limit";
import {
  createContextStore,
  createTransformContext,
  SkipDocumentError,
  type ContextStore,
} from "./context";
import type { ParsedDocument } from "./parser";
import type { ResolvedConfig } from "./config";
import type {
  AnyCollection,
  RuntimeEntry,
  TransformError as TransformErrorType,
  SerializationError as SerializationErrorType,
} from "./types";
import { TransformError, SerializationError } from "./types";
import { validateSerializable, hasCriticalIssues } from "./serialization";
import { createSyncHasher, type CacheManager } from "./cache";
import {
  createRenderer,
  type RenderOptions,
  type RenderResult,
  type Renderer,
} from "@keel/content-markdown";
import type * as ContentMdxModule from "@keel/content-mdx";

/** Lazy-loaded MDX module - cached after first successful import */
type MdxModule = typeof ContentMdxModule;
let mdxModule: MdxModule | null = null;
let mdxLoadAttempted = false;

/**
 * Lazy-load the MDX module.
 * Returns null if @keel/content-mdx is not installed.
 */
async function getMdxModule(): Promise<MdxModule | null> {
  if (mdxModule) return mdxModule;
  if (mdxLoadAttempted) return null;

  mdxLoadAttempted = true;
  try {
    mdxModule = await import("@keel/content-mdx");
    return mdxModule;
  } catch {
    return null;
  }
}

const DEFAULT_CONCURRENCY = Math.max(1, os.cpus().length - 1);

// Cache renderers by options hash to avoid recreating for each document
const rendererCache = new Map<string, Renderer>();

function getRenderer(options: RenderOptions = {}): Renderer {
  const key = JSON.stringify(options);
  let renderer = rendererCache.get(key);
  if (!renderer) {
    renderer = createRenderer(options);
    rendererCache.set(key, renderer);
  }
  return renderer;
}

/** @internal Clear renderer cache - called by generator on each build */
export function clearRendererCache(): void {
  rendererCache.clear();
}

export interface TransformOptions {
  concurrency?: number;
  cache?: CacheManager;
}

export interface TransformResult {
  entries: RuntimeEntry[];
  skipped: string[];
  errors: TransformErrorType[];
  serializationErrors: SerializationErrorType[];
}

type DocResult =
  | { type: "success"; entry: RuntimeEntry; serializationError: SerializationErrorType | undefined }
  | { type: "skipped"; path: string }
  | { type: "error"; error: TransformErrorType };

function createParseHashGetter(
  doc: ParsedDocument,
  collection: AnyCollection,
  syncHasher: ReturnType<typeof createSyncHasher>,
) {
  return () =>
    syncHasher.hashObject({
      data: doc.document.data,
      content: doc.document.content,
      slug: doc.slug,
      computed: collection.computed ? Object.keys(collection.computed).toSorted() : undefined,
      isMDX: doc.isMDX,
      mdxConfig: doc.isMDX ? collection.mdx : undefined,
    });
}

function buildCachedEntry(
  doc: ParsedDocument,
  collection: AnyCollection,
  entryId: string,
  cached: NonNullable<ReturnType<CacheManager["getTransformCache"]>>,
): RuntimeEntry {
  if (cached.transformed) {
    return {
      ...cached.transformed,
      id: entryId,
      collection: collection.name,
      file: doc.document.file,
    };
  }
  return {
    ...doc.document.data,
    content: doc.document.content,
    slug: doc.slug,
    id: entryId,
    collection: collection.name,
    file: doc.document.file,
    ...(cached.rendered ? { rendered: cached.rendered } : {}),
    ...(cached.mdxCode ? { mdx: { code: cached.mdxCode } } : {}),
  };
}

async function buildTransformedEntry(
  doc: ParsedDocument,
  collection: AnyCollection,
  store: ContextStore,
  entryId: string,
): Promise<{ entry: RuntimeEntry; transformResult: Record<string, unknown> }> {
  const context = createTransformContext(
    collection.name,
    collection.directory,
    doc.file.absolutePath,
    store,
  );
  const result = await collection.transform!(doc.document, context);
  const transformResult = result as Record<string, unknown>;
  return {
    entry: {
      ...transformResult,
      id: entryId,
      collection: collection.name,
      file: doc.document.file,
    },
    transformResult,
  };
}

async function buildMdxEntry(
  doc: ParsedDocument,
  collection: AnyCollection,
  entryId: string,
): Promise<RuntimeEntry> {
  // Lazy-load MDX module
  const mdx = await getMdxModule();
  if (!mdx) {
    throw new Error(
      `MDX file detected (${doc.file.absolutePath}) but @keel/content-mdx is not installed.\n` +
        `Install it with: bun add @keel/content-mdx\n` +
        `Or use .md extension instead of .mdx for plain markdown.`,
    );
  }

  // MDX plugins are passed as unified Pluggables at runtime.
  // The core PluginConfig type is string-based for config serialization,
  // but actual runtime values are plugin functions. We cast to the expected
  // PluggableList type which the compileMDX function accepts.
  type PluggableList = NonNullable<Parameters<typeof mdx.compileMDX>[0]["remarkPlugins"]>;
  const mdxResult = await mdx.compileMDX({
    source: doc.document.content,
    cwd: path.dirname(doc.file.absolutePath),
    ...(collection.mdx?.remarkPlugins && {
      remarkPlugins: collection.mdx.remarkPlugins as PluggableList,
    }),
    ...(collection.mdx?.rehypePlugins && {
      rehypePlugins: collection.mdx.rehypePlugins as PluggableList,
    }),
  });
  return {
    ...doc.document.data,
    ...mdxResult.frontmatter,
    content: doc.document.content,
    slug: doc.slug,
    id: entryId,
    collection: collection.name,
    file: doc.document.file,
    mdx: { code: mdxResult.code },
    rendered: {
      headings: mdxResult.headings,
      readingTime: mdxResult.readingTime,
      excerpt: mdxResult.excerpt,
      html: null,
    },
  };
}

async function buildMarkdownEntry(
  doc: ParsedDocument,
  collection: AnyCollection,
  entryId: string,
): Promise<RuntimeEntry> {
  const entry: RuntimeEntry = {
    ...doc.document.data,
    content: doc.document.content,
    slug: doc.slug,
    id: entryId,
    collection: collection.name,
    file: doc.document.file,
  };
  if (collection.render !== false) {
    const renderOptions = typeof collection.render === "object" ? collection.render : {};
    const renderer = getRenderer(renderOptions);
    const renderResult = await renderer.render(doc.document.content);
    entry["rendered"] = renderResult;
  }
  return entry;
}

function applyComputedFields(
  entry: RuntimeEntry,
  doc: ParsedDocument,
  collection: AnyCollection,
): void {
  if (!collection.computed) return;
  const computedInput = {
    ...doc.document.data,
    content: doc.document.content,
    slug: doc.slug,
  };
  for (const [fieldName, computeFn] of Object.entries(collection.computed)) {
    try {
      entry[fieldName] = computeFn(computedInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Computed field "${fieldName}" failed: ${message}`, { cause: error });
    }
  }
}

function validateEntrySerialization(
  entry: RuntimeEntry,
  entryId: string,
  filePath: string,
  mode: string,
): SerializationErrorType | undefined {
  const validationResult = validateSerializable(entry);
  if (validationResult.valid) return undefined;
  if (!hasCriticalIssues(validationResult)) return undefined;
  const error = new SerializationError(validationResult.issues, entryId, filePath);
  if (mode === "production") throw error;
  return error;
}

function cacheTransformResult(
  cache: CacheManager,
  collection: AnyCollection,
  entryId: string,
  entry: RuntimeEntry,
  transformResult: Record<string, unknown> | null,
  getParseHash: () => string,
): void {
  const mdxData = entry["mdx"] as { code: string } | undefined;
  const rendered = entry["rendered"] as RenderResult | undefined;
  const cacheData: Parameters<typeof cache.setTransformCache>[2] = {
    parseHash: getParseHash(),
    transformed: transformResult,
    skipped: false,
  };
  if (!transformResult && rendered) {
    cacheData.rendered = rendered;
  }
  if (mdxData?.code) {
    cacheData.mdxCode = mdxData.code;
  }
  cache.setTransformCache(collection.name, entryId, cacheData);
}

/** Try to get cached result for a document */
function tryGetCachedResult(
  cache: CacheManager | undefined,
  syncHasher: ReturnType<typeof createSyncHasher> | undefined,
  doc: ParsedDocument,
  collection: AnyCollection,
  entryId: string,
  getParseHash: () => string,
): DocResult | null {
  if (!cache || !syncHasher) return null;

  const cached = cache.getTransformCache(collection.name, entryId, getParseHash());
  if (!cached) return null;

  if (cached.skipped) {
    return { type: "skipped", path: doc.file.absolutePath };
  }
  const entry = buildCachedEntry(doc, collection, entryId, cached);
  return { type: "success", entry, serializationError: undefined };
}

/** Build entry based on collection configuration */
async function buildEntry(
  doc: ParsedDocument,
  collection: AnyCollection,
  store: ContextStore,
  entryId: string,
): Promise<{ entry: RuntimeEntry; transformResult: Record<string, unknown> | null }> {
  if (collection.transform) {
    return buildTransformedEntry(doc, collection, store, entryId);
  }
  const entry = doc.isMDX
    ? await buildMdxEntry(doc, collection, entryId)
    : await buildMarkdownEntry(doc, collection, entryId);
  return { entry, transformResult: null };
}

/** Handle SkipDocumentError */
function handleSkipDocumentError(
  cache: CacheManager | undefined,
  syncHasher: ReturnType<typeof createSyncHasher> | undefined,
  collection: AnyCollection,
  entryId: string,
  doc: ParsedDocument,
  getParseHash: () => string,
): DocResult {
  if (cache && syncHasher) {
    cache.setTransformCache(collection.name, entryId, {
      parseHash: getParseHash(),
      transformed: null,
      skipped: true,
    });
  }
  return { type: "skipped", path: doc.file.absolutePath };
}

/** Handle transform errors */
function handleTransformError(
  error: unknown,
  entryId: string,
  doc: ParsedDocument,
  mode: string,
): DocResult {
  const transformError = new TransformError(entryId, doc.file.absolutePath, error);
  if (mode === "production") throw transformError;
  return { type: "error", error: transformError };
}

/** Process a successful transform and cache if appropriate */
function processSuccessfulTransform(
  entry: RuntimeEntry,
  transformResult: Record<string, unknown> | null,
  doc: ParsedDocument,
  collection: AnyCollection,
  entryId: string,
  config: ResolvedConfig,
  cache: CacheManager | undefined,
  syncHasher: ReturnType<typeof createSyncHasher> | undefined,
  getParseHash: () => string,
): DocResult {
  applyComputedFields(entry, doc, collection);

  const shouldValidate = collection.validateSerialization !== false;
  const serializationError = shouldValidate
    ? validateEntrySerialization(entry, entryId, doc.file.absolutePath, config.mode)
    : undefined;

  if (cache && syncHasher && !serializationError) {
    cacheTransformResult(cache, collection, entryId, entry, transformResult, getParseHash);
  }

  return { type: "success", entry, serializationError };
}

async function transformDocument(
  doc: ParsedDocument,
  collection: AnyCollection,
  store: ContextStore,
  config: ResolvedConfig,
  cache?: CacheManager,
  syncHasher?: ReturnType<typeof createSyncHasher>,
): Promise<DocResult> {
  const entryId = `${collection.name}/${doc.slug}`;
  const getParseHash = syncHasher ? createParseHashGetter(doc, collection, syncHasher) : () => "";

  const cachedResult = tryGetCachedResult(
    cache,
    syncHasher,
    doc,
    collection,
    entryId,
    getParseHash,
  );
  if (cachedResult) return cachedResult;

  try {
    const { entry, transformResult } = await buildEntry(doc, collection, store, entryId);
    return processSuccessfulTransform(
      entry,
      transformResult,
      doc,
      collection,
      entryId,
      config,
      cache,
      syncHasher,
      getParseHash,
    );
  } catch (error) {
    if (error instanceof SkipDocumentError) {
      return handleSkipDocumentError(cache, syncHasher, collection, entryId, doc, getParseHash);
    }
    if (error instanceof SerializationError) throw error;
    return handleTransformError(error, entryId, doc, config.mode);
  }
}

export async function transform(
  documents: ParsedDocument[],
  config: ResolvedConfig,
  options: TransformOptions = {},
): Promise<TransformResult> {
  const { concurrency = DEFAULT_CONCURRENCY, cache } = options;
  const limit = pLimit(concurrency);
  const syncHasher = cache ? createSyncHasher() : undefined;

  const entries: RuntimeEntry[] = [];
  const skipped: string[] = [];
  const errors: TransformErrorType[] = [];
  const serializationErrors: SerializationErrorType[] = [];

  const byCollection = new Map<string, ParsedDocument[]>();
  for (const doc of documents) {
    const name = doc.file.collection.name;
    if (!byCollection.has(name)) {
      byCollection.set(name, []);
    }
    byCollection.get(name)!.push(doc);
  }

  const store = createContextStore();

  for (const collection of config.collections) {
    const collectionDocs = byCollection.get(collection.name) ?? [];
    const collectionEntries: RuntimeEntry[] = [];

    const results = await Promise.all(
      collectionDocs.map((doc) =>
        limit(() => transformDocument(doc, collection, store, config, cache, syncHasher)),
      ),
    );

    for (const result of results) {
      switch (result.type) {
        case "success":
          collectionEntries.push(result.entry);
          entries.push(result.entry);
          if (result.serializationError) {
            serializationErrors.push(result.serializationError);
          }
          break;
        case "skipped":
          skipped.push(result.path);
          break;
        case "error":
          errors.push(result.error);
          break;
      }
    }

    store.collections.set(collection.name, collectionEntries);
  }

  return { entries, skipped, errors, serializationErrors };
}
