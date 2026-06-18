import { z } from "zod";
import type { ParserOption } from "@volo/content-umbra";
import type {
  AnyCollection,
  CollectionSchema,
  Document,
  DocumentMeta,
  TransformContext,
  ValidationMode,
} from "../types";
import type { AnyTaxonomy } from "../taxonomy";
import type { CollectedFile } from "../collector";
import type { ParsedDocument } from "../parser";
import type { ResolvedConfig } from "../config";

// ============================================================================
// Collection Helpers
// ============================================================================

export interface CreateCollectionOptions {
  name?: string;
  directory?: string;
  include?: string | string[];
  exclude?: string | string[];
  schema?: CollectionSchema;
  parser?: ParserOption;
  transform?: AnyCollection["transform"];
  transformedSchema?: CollectionSchema;
  validateSerialization?: boolean;
}

export function createTestCollection(overrides: CreateCollectionOptions = {}): AnyCollection {
  return {
    name: overrides.name ?? "posts",
    directory: overrides.directory ?? "content/posts",
    schema: overrides.schema ?? z.object({ title: z.string() }),
    ...(overrides.include === undefined ? {} : { include: overrides.include }),
    ...(overrides.exclude === undefined ? {} : { exclude: overrides.exclude }),
    ...(overrides.parser === undefined ? {} : { parser: overrides.parser }),
    ...(overrides.transform === undefined ? {} : { transform: overrides.transform }),
    ...(overrides.transformedSchema === undefined
      ? {}
      : { transformedSchema: overrides.transformedSchema }),
    ...(overrides.validateSerialization === undefined
      ? {}
      : { validateSerialization: overrides.validateSerialization }),
  };
}

// ============================================================================
// Document Helpers
// ============================================================================

export interface CreateDocumentMetaOptions {
  path?: string;
  fileName?: string;
  extension?: string;
  directory?: string;
  pathSegments?: string[];
  isIndex?: boolean;
}

export function createDocumentMeta(overrides: CreateDocumentMetaOptions = {}): DocumentMeta {
  const fileName = overrides.fileName ?? "test";
  const extension = overrides.extension ?? "md";
  const directory = overrides.directory ?? ".";
  const isIndex =
    overrides.isIndex ?? (fileName === "index" || fileName.toLowerCase() === "readme");
  // Derive pathSegments from directory and fileName if not provided
  const defaultSegments =
    directory === "."
      ? isIndex
        ? []
        : [fileName]
      : isIndex
        ? directory.split("/")
        : [...directory.split("/"), fileName];
  return {
    path: overrides.path ?? `${fileName}.${extension}`,
    fileName,
    extension,
    directory,
    pathSegments: overrides.pathSegments ?? defaultSegments,
    isIndex,
  };
}

export interface CreateDocumentOptions<TData extends Record<string, unknown>> {
  data?: TData;
  content?: string;
  meta?: CreateDocumentMetaOptions;
}

export function createTestDocument<TData extends Record<string, unknown> = Record<string, unknown>>(
  options: CreateDocumentOptions<TData> = {},
): Document<TData> {
  return {
    data: (options.data ?? {}) as TData,
    content: options.content ?? "",
    file: createDocumentMeta(options.meta),
  };
}

// ============================================================================
// Collected File Helpers
// ============================================================================

export interface CreateCollectedFileOptions {
  absolutePath?: string;
  relativePath?: string;
  collection?: CreateCollectionOptions;
}

export function createCollectedFile(overrides: CreateCollectedFileOptions = {}): CollectedFile {
  const relativePath = overrides.relativePath ?? "post.md";
  return {
    absolutePath: overrides.absolutePath ?? `/path/to/${relativePath}`,
    relativePath,
    collection: createTestCollection(overrides.collection),
  };
}

// ============================================================================
// Parsed Document Helpers
// ============================================================================

export interface CreateParsedDocumentOptions<TData extends Record<string, unknown>> {
  slug?: string;
  collectionName?: string;
  data?: TData;
  content?: string;
  absolutePath?: string;
  relativePath?: string;
  collection?: CreateCollectionOptions;
}

export function createParsedDocument<
  TData extends Record<string, unknown> = Record<string, unknown>,
>(options: CreateParsedDocumentOptions<TData> = {}): ParsedDocument {
  const slug = options.slug ?? "test";
  const collectionName = options.collectionName ?? "posts";
  const relativePath = options.relativePath ?? `${slug}.md`;

  return {
    file: createCollectedFile({
      absolutePath: options.absolutePath ?? `/path/to/${slug}.md`,
      relativePath,
      collection: {
        name: collectionName,
        directory: options.collection?.directory ?? `content/${collectionName}`,
        ...(options.collection?.schema === undefined ? {} : { schema: options.collection.schema }),
        ...(options.collection?.transform === undefined
          ? {}
          : { transform: options.collection.transform }),
        ...(options.collection?.validateSerialization === undefined
          ? {}
          : { validateSerialization: options.collection.validateSerialization }),
      },
    }),
    document: createTestDocument({
      ...(options.data === undefined ? {} : { data: options.data }),
      ...(options.content === undefined ? {} : { content: options.content }),
      meta: {
        path: relativePath,
        fileName: slug,
        extension: "md",
        directory: ".",
      },
    }),
    slug,
    isMDX: false,
  };
}

// ============================================================================
// Config Helpers
// ============================================================================

export interface CreateResolvedConfigOptions {
  configPath?: string | null;
  cwd?: string;
  collections?: AnyCollection[];
  taxonomies?: AnyTaxonomy[];
  mode?: ValidationMode;
}

export function createResolvedConfig(overrides: CreateResolvedConfigOptions = {}): ResolvedConfig {
  return {
    configPath: overrides.configPath ?? null,
    cwd: overrides.cwd ?? "/project",
    collections: overrides.collections ?? [],
    taxonomies: overrides.taxonomies ?? [],
    mode: overrides.mode ?? "development",
  };
}

// ============================================================================
// Transform Function Types
// ============================================================================

/** Type for transform functions used in tests */
export type TestTransformFn<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
> = (doc: Document<TInput>, ctx: TransformContext) => TOutput | void;

/** Type for async transform functions used in tests */
export type TestAsyncTransformFn<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
> = (doc: Document<TInput>, ctx: TransformContext) => Promise<TOutput | void>;

// ============================================================================
// File System Test Helpers
// ============================================================================

import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface TempDirContext {
  tempDir: string;
  cleanup: () => Promise<void>;
}

export async function createTempDir(prefix = "docks-test-"): Promise<TempDirContext> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    tempDir,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

export interface FileSetupOptions {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export async function setupTestFiles(tempDir: string, files: FileSetupOptions[]): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      const fullPath = path.join(tempDir, file.path);
      await mkdir(path.dirname(fullPath), { recursive: true });
      const fm = Object.entries(file.frontmatter)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n");
      await writeFile(fullPath, `---\n${fm}\n---\n\n${file.content}`);
    }),
  );
}

export async function readTestFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

export async function testFileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Narrow `T | undefined` to `T`, throwing if the value is absent.
 * Used in tests to assert that an indexed access (e.g. `arr[0]`) is present,
 * preserving the original runtime behavior (a thrown error on absence) while
 * satisfying `noUncheckedIndexedAccess`.
 */
export function nn<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected value to be defined");
  }
  return value;
}

// ============================================================================
// Async Helpers
// ============================================================================

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  { timeout = 1000, interval = 10 } = {},
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeout) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
