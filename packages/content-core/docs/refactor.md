# Docks Core Refactor: Content-Collections Architecture

This document outlines the architectural refactor of `@usedocks/core` and `@usedocks/next` to implement strongly-typed content collections following patterns established by [content-collections](https://github.com/sdorra/content-collections) and Astro's content layer.

## Table of Contents

1. [Design Decisions](#design-decisions)
2. [Architecture Overview](#architecture-overview)
3. [Type System](#type-system)
4. [Implementation Details](#implementation-details)
5. [Migration Guide](#migration-guide)
6. [Examples](#examples)

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Import pattern** | All from `@usedocks/core` | Single source of truth, simpler mental model |
| **Type generation** | Schema-based (not data-based) | Types derived from schema definition, not runtime values |
| **Transform types** | Explicit type parameter | `defineCollection<Schema, Transformed>()` for full type safety |
| **Backwards compat** | Clean break | Simpler codebase, no deprecation warnings |
| **Context API** | Full feature set | `documents()`, `cache()`, `skip()` with improved DX |
| **Legacy module-based imports** | Removed | Use runtime API (`getCollection`, `getEntry`) |

---

## Architecture Overview

### Pipeline Architecture

Following content-collections' pattern, we'll implement a **pipeline architecture** instead of a monolithic `scan()` function. Each stage has a single responsibility and can be tested, cached, and composed independently.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PIPELINE ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌───────────┐   ┌─────────┐ │
│   │  Config  │ → │ Collect  │ → │  Parse   │ → │ Transform │ → │  Write  │ │
│   └──────────┘   └──────────┘   └──────────┘   └───────────┘   └─────────┘ │
│        │              │              │               │              │       │
│        ▼              ▼              ▼               ▼              ▼       │
│   Load config    Find files    Parse files    Apply transforms   Generate  │
│   from file      via glob      (frontmatter   with context       types.d.ts│
│                  patterns      + content)                        + runtime │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                        SYNCHRONIZER                                  │  │
│   │   Handles incremental updates in watch mode                         │  │
│   │   - Tracks file → collection mapping                                │  │
│   │   - Re-runs only affected stages                                    │  │
│   │   - Maintains in-memory state                                       │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Pipeline Benefits

| Benefit | How It Helps |
|---------|--------------|
| **Single Responsibility** | Each stage does one thing well, easier to reason about |
| **Testability** | Unit test each stage in isolation with mock inputs/outputs |
| **Caching** | Cache parsed files, only re-transform changed content |
| **Parallelization** | Parse multiple files concurrently, transform in parallel |
| **Incremental Updates** | Synchronizer updates only affected files in watch mode |
| **Error Isolation** | Clear error messages indicating which stage failed |
| **Extensibility** | Future: middleware hooks between stages |
| **Event-Driven** | Emit events for progress tracking and logging |

### Pipeline Stages

```typescript
// Each stage is a pure(ish) function with clear inputs/outputs

// Stage 1: Config
type ConfigStage = (cwd: string) => Promise<ResolvedConfig>;

// Stage 2: Collect
type CollectStage = (config: ResolvedConfig) => Promise<CollectedFile[]>;

// Stage 3: Parse
type ParseStage = (files: CollectedFile[], config: ResolvedConfig) => Promise<ParsedDocument[]>;

// Stage 4: Transform
type TransformStage = (documents: ParsedDocument[], config: ResolvedConfig) => Promise<Entry[]>;

// Stage 5: Write
type WriteStage = (entries: Entry[], config: ResolvedConfig) => Promise<GeneratedOutput>;
```

### Current Architecture (Problems)

```
┌─────────────────────────────────────────────────────────────┐
│ CURRENT IMPLEMENTATION                                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  docks.config.ts                                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ collections: {                                        │   │
│  │   posts: defineCollection({                           │   │
│  │     schema: z.object({...}),  // Schema defined      │   │
│  │     transform: (entry) => ({...})                    │   │
│  │   })                                                  │   │
│  │ }                                                     │   │
│  └──────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ scanner.ts                                            │   │
│  │ - Implicit collection from folder structure           │   │
│  │ - content/posts/*.md → "posts" collection            │   │
│  └──────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ typegen.ts                                            │   │
│  │ - INFERS TYPES FROM DATA (wrong!)                    │   │
│  │ - function inferType(value: unknown): string         │   │
│  │ - Types depend on content, not schema                │   │
│  └──────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ DUAL API (confusing)                                  │   │
│  │ - import { getEntry } from "@usedocks/core"           │   │
│  │ - import { getPost } from ".docks"                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ TARGET IMPLEMENTATION                                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  docks.config.ts                                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ collections: [                                        │   │
│  │   defineCollection<PostSchema, PostTransformed>({    │   │
│  │     name: "posts",                                   │   │
│  │     directory: "content/posts",                      │   │
│  │     include: "**/*.md",                              │   │
│  │     schema: PostSchema,                              │   │
│  │     transform: (doc, ctx) => ({...})                 │   │
│  │   })                                                  │   │
│  │ ]                                                     │   │
│  └──────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ scanner.ts                                            │   │
│  │ - Explicit collection config                          │   │
│  │ - Glob patterns per collection                        │   │
│  │ - Transform context with documents(), cache(), skip() │   │
│  └──────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ typegen.ts                                            │   │
│  │ - EXTRACTS TYPES FROM SCHEMA (correct!)              │   │
│  │ - Zod introspection via _def                          │   │
│  │ - Types match schema, not content                     │   │
│  └──────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ SINGLE API                                            │   │
│  │ - import { getEntry, getCollection } from "@usedocks/core"│
│  │ - Types via CollectionRegistry augmentation          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Type System

### Core Types

```typescript
// ============================================================================
// packages/core/src/types.ts
// ============================================================================

import type { StandardSchemaV1 } from "@standard-schema/spec";

// ---------------------------------------------------------------------------
// Schema Utilities
// ---------------------------------------------------------------------------

/**
 * Infer the output type from a Standard Schema.
 */
export type InferOutput<T> = T extends StandardSchemaV1<unknown, infer O> ? O : never;

/**
 * Schema definition for a collection.
 * Accepts any Standard Schema compliant validator (Zod, Valibot, ArkType, etc.)
 */
export type CollectionSchema = StandardSchemaV1<Record<string, unknown>, Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Document Types
// ---------------------------------------------------------------------------

/**
 * File metadata attached to every document.
 */
export interface DocumentMeta {
  /** Relative path from collection directory */
  path: string;

  /** Filename without extension */
  fileName: string;

  /** File extension (e.g., "md", "mdx") */
  extension: string;

  /** Directory path relative to collection root */
  directory: string;
}

/**
 * Document passed to transform function.
 * Contains validated frontmatter data and raw content.
 */
export interface Document<TData extends Record<string, unknown> = Record<string, unknown>> {
  /** Validated frontmatter data */
  readonly data: TData;

  /** Raw markdown content (without frontmatter) */
  readonly content: string;

  /** File metadata */
  readonly _meta: DocumentMeta;
}

// ---------------------------------------------------------------------------
// Entry Types
// ---------------------------------------------------------------------------

/**
 * A content entry representing a processed markdown file.
 * This is what gets stored in collections and returned by the API.
 */
export interface Entry<
  TData extends Record<string, unknown> = Record<string, unknown>,
  TTransformed extends Record<string, unknown> | undefined = undefined,
> {
  /** Unique identifier: `${collection}/${slug}` */
  readonly id: string;

  /** URL-friendly identifier derived from filename */
  readonly slug: string;

  /** Collection name */
  readonly collection: string;

  /** Validated frontmatter data */
  readonly data: TData;

  /** Raw markdown content */
  readonly content: string;

  /** File metadata */
  readonly _meta: DocumentMeta;

  /** Computed properties from transform function (if defined) */
  readonly transformed: TTransformed;
}

// ---------------------------------------------------------------------------
// Transform Context
// ---------------------------------------------------------------------------

/**
 * Context object passed to transform functions.
 * Provides utilities for cross-collection access, caching, and conditional processing.
 */
export interface TransformContext {
  /**
   * Access entries from another collection.
   *
   * Collections are processed in order, so you can only access
   * collections that appear earlier in your config.
   *
   * @example
   * ```ts
   * transform: (doc, ctx) => {
   *   const authors = ctx.documents(authorsCollection);
   *   const author = authors.find(a => a.slug === doc.data.authorSlug);
   *   return { authorName: author?.data.name ?? "Unknown" };
   * }
   * ```
   */
  documents<T extends AnyCollection>(collection: T): InferEntry<T>[];

  /**
   * Cache expensive computations.
   * Results are memoized by key within the current build.
   *
   * @example
   * ```ts
   * transform: async (doc, ctx) => {
   *   // Only computed once per unique slug
   *   const ogImage = await ctx.cache(`og:${doc._meta.fileName}`, async () => {
   *     return generateOGImage(doc.data.title);
   *   });
   *   return { ogImage };
   * }
   * ```
   */
  cache<T>(key: string, fn: () => T | Promise<T>): Promise<T>;

  /**
   * Skip this document (exclude from final collection).
   * Throws internally - do not catch this error.
   *
   * @example
   * ```ts
   * transform: (doc, ctx) => {
   *   if (doc.data.draft && process.env.NODE_ENV === "production") {
   *     ctx.skip(); // Document won't appear in production
   *   }
   *   return { readingTime: calculateReadingTime(doc.content) };
   * }
   * ```
   */
  skip(): never;

  /**
   * Metadata about the current collection being processed.
   */
  readonly collection: {
    readonly name: string;
    readonly directory: string;
  };

  /**
   * Absolute path to the current file being processed.
   */
  readonly filePath: string;
}

// ---------------------------------------------------------------------------
// Transform Function
// ---------------------------------------------------------------------------

/**
 * Transform function that computes additional properties for an entry.
 * Runs at scan time and results are cached on the entry.
 *
 * @typeParam TData - The validated frontmatter data type (from schema)
 * @typeParam TTransformed - The transform output type (explicit)
 */
export type TransformFn<
  TData extends Record<string, unknown> = Record<string, unknown>,
  TTransformed extends Record<string, unknown> | undefined = undefined,
> = (
  document: Document<TData>,
  context: TransformContext
) => TTransformed extends undefined
  ? void | undefined
  : TTransformed | Promise<TTransformed>;

// ---------------------------------------------------------------------------
// Collection Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a single content collection.
 *
 * @typeParam TSchema - Standard Schema validator type
 * @typeParam TTransformed - Transform output type (must be explicit)
 */
export interface CollectionConfig<
  TSchema extends CollectionSchema = CollectionSchema,
  TTransformed extends Record<string, unknown> | undefined = undefined,
> {
  /**
   * Unique name for this collection.
   * Used in API calls: `getCollection("posts")`
   */
  name: string;

  /**
   * Directory containing content files.
   * Can be relative to cwd or absolute.
   *
   * @example "content/posts"
   * @example "/absolute/path/to/content"
   */
  directory: string;

  /**
   * Glob pattern(s) for files to include.
   * @default "**\/*.md"
   *
   * @example "**\/*.{md,mdx}"
   * @example ["posts/*.md", "drafts/*.md"]
   */
  include?: string | string[];

  /**
   * Glob pattern(s) for files to exclude.
   * node_modules is always excluded.
   *
   * @example "**\/_*"
   * @example ["drafts/**", "**\/*.draft.md"]
   */
  exclude?: string | string[];

  /**
   * Standard Schema validator for frontmatter data.
   * Supports Zod, Valibot, ArkType, and other compatible libraries.
   */
  schema: TSchema;

  /**
   * Transform function to compute additional properties.
   * Results are cached on the entry's `transformed` property.
   */
  transform?: TransformFn<InferOutput<TSchema>, TTransformed>;
}

/**
 * Any collection config (for type constraints on arrays).
 */
export type AnyCollection = CollectionConfig<CollectionSchema, Record<string, unknown> | undefined>;

/**
 * Infer the Entry type from a collection config.
 */
export type InferEntry<T extends AnyCollection> = Entry<
  InferOutput<T["schema"]>,
  T extends CollectionConfig<CollectionSchema, infer R> ? R : undefined
>;

// ---------------------------------------------------------------------------
// Engine Configuration
// ---------------------------------------------------------------------------

/**
 * Validation mode for schema validation.
 */
export type ValidationMode = "development" | "production";

/**
 * Configuration for the content engine.
 */
export interface EngineConfig<TCollections extends AnyCollection[] = AnyCollection[]> {
  /**
   * Working directory.
   * @default process.cwd()
   */
  cwd?: string;

  /**
   * Collection definitions.
   * Order matters: earlier collections can be accessed by later ones via context.documents()
   */
  collections: TCollections;

  /**
   * Validation mode.
   * - 'development': Warn on errors, skip invalid entries
   * - 'production': Fail fast on errors
   * @default "development"
   */
  mode?: ValidationMode;

  /**
   * Callback for validation warnings in development mode.
   */
  onValidationWarning?: (error: ValidationError) => void;

  /**
   * Callback for slug collisions.
   * First entry wins; subsequent duplicates are skipped.
   */
  onSlugCollision?: (existing: Entry, duplicate: Entry) => void;

  /**
   * Callback for transform errors in development mode.
   */
  onTransformError?: (error: TransformError) => void;
}

// ---------------------------------------------------------------------------
// Collection Registry (Module Augmentation)
// ---------------------------------------------------------------------------

/**
 * Registry of collection types for type-safe runtime API.
 * This interface is augmented by generated types.
 *
 * @example Generated augmentation:
 * ```ts
 * declare module "@usedocks/core" {
 *   interface CollectionRegistry {
 *     posts: {
 *       data: { title: string; publishedAt: Date };
 *       transformed: { readingTime: number };
 *     };
 *   }
 * }
 * ```
 */
export interface CollectionRegistry {}

/**
 * Get the data type for a registered collection.
 */
export type CollectionData<K extends keyof CollectionRegistry> =
  CollectionRegistry[K] extends { data: infer D } ? D : Record<string, unknown>;

/**
 * Get the transformed type for a registered collection.
 */
export type CollectionTransformed<K extends keyof CollectionRegistry> =
  CollectionRegistry[K] extends { transformed: infer T } ? T : undefined;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Define a collection configuration with type inference.
 *
 * @typeParam TSchema - Inferred from schema parameter
 * @typeParam TTransformed - Must be explicitly provided if using transform
 */
export function defineCollection<
  TSchema extends CollectionSchema,
  TTransformed extends Record<string, unknown> | undefined = undefined,
>(
  config: CollectionConfig<TSchema, TTransformed>
): CollectionConfig<TSchema, TTransformed> {
  return config;
}

/**
 * Define the Docks configuration.
 */
export function defineConfig<TCollections extends AnyCollection[]>(
  config: EngineConfig<TCollections>
): EngineConfig<TCollections> {
  return config;
}
```

---

## Implementation Details

### Transform Context Implementation

```typescript
// ============================================================================
// packages/core/src/context.ts (NEW FILE)
// ============================================================================

import type { AnyCollection, Entry, InferEntry, TransformContext } from "./types";

/**
 * Error thrown when context.skip() is called.
 * Should not be caught by user code.
 */
export class SkipDocumentError extends Error {
  constructor() {
    super("Document skipped via context.skip()");
    this.name = "SkipDocumentError";
  }
}

/**
 * Internal store shared across transform executions.
 */
export interface ContextStore {
  /** Memoization cache for context.cache() calls */
  cache: Map<string, unknown>;

  /** Processed collections for context.documents() access */
  collections: Map<string, Entry[]>;
}

/**
 * Create an empty context store.
 */
export function createContextStore(): ContextStore {
  return {
    cache: new Map(),
    collections: new Map(),
  };
}

/**
 * Create a transform context for a specific document.
 */
export function createTransformContext(
  collectionName: string,
  collectionDirectory: string,
  filePath: string,
  store: ContextStore
): TransformContext {
  return {
    documents<T extends AnyCollection>(collection: T): InferEntry<T>[] {
      const name = collection.name;
      const entries = store.collections.get(name);

      if (!entries) {
        // Check if the collection exists but hasn't been processed yet
        throw new Error(
          `Collection "${name}" not found. ` +
          `If it exists, make sure it appears before "${collectionName}" in your collections array. ` +
          `Collections can only access other collections that are defined earlier.`
        );
      }

      return entries as InferEntry<T>[];
    },

    async cache<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
      // Namespace cache keys by collection to avoid collisions
      const cacheKey = `${collectionName}:${key}`;

      if (store.cache.has(cacheKey)) {
        return store.cache.get(cacheKey) as T;
      }

      const result = await fn();
      store.cache.set(cacheKey, result);
      return result;
    },

    skip(): never {
      throw new SkipDocumentError();
    },

    collection: {
      name: collectionName,
      directory: collectionDirectory,
    },

    filePath,
  };
}
```

### Schema-Based Type Generation

```typescript
// ============================================================================
// packages/core/src/typegen.ts (REWRITE)
// ============================================================================

import type { CollectionConfig, AnyCollection } from "./types";
import { toPascalCase, toSafeKey } from "./utils";

// ---------------------------------------------------------------------------
// Schema Introspection
// ---------------------------------------------------------------------------

/**
 * Detect which schema library is being used.
 */
function detectSchemaLibrary(schema: unknown): "zod" | "valibot" | "arktype" | "unknown" {
  // Zod: has _def.typeName
  if ((schema as any)?._def?.typeName) {
    return "zod";
  }

  // Valibot: has type and ~standard property
  if ((schema as any)?.type && (schema as any)["~standard"]) {
    return "valibot";
  }

  // ArkType: has infer and json properties
  if ((schema as any)?.infer && (schema as any)?.json) {
    return "arktype";
  }

  return "unknown";
}

/**
 * Extract TypeScript type string from a Zod schema.
 * Uses internal _def structure for introspection.
 */
function zodToTypeString(schema: unknown, depth = 0): string {
  // Prevent infinite recursion
  if (depth > 10) return "unknown";

  const def = (schema as any)?._def;
  if (!def) return "unknown";

  const typeName = def.typeName;

  switch (typeName) {
    // Primitives
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodBigInt":
      return "bigint";
    case "ZodDate":
      return "Date";
    case "ZodUndefined":
      return "undefined";
    case "ZodNull":
      return "null";
    case "ZodVoid":
      return "void";
    case "ZodAny":
      return "any";
    case "ZodUnknown":
      return "unknown";
    case "ZodNever":
      return "never";
    case "ZodSymbol":
      return "symbol";

    // Literals
    case "ZodLiteral":
      return JSON.stringify(def.value);

    // Enums
    case "ZodEnum":
      return def.values.map((v: string) => JSON.stringify(v)).join(" | ");
    case "ZodNativeEnum": {
      const values = Object.values(def.values as Record<string, string | number>);
      return values.map((v) => JSON.stringify(v)).join(" | ");
    }

    // Composites
    case "ZodArray":
      return `(${zodToTypeString(def.type, depth + 1)})[]`;

    case "ZodTuple": {
      const items = def.items.map((item: unknown) => zodToTypeString(item, depth + 1));
      return `[${items.join(", ")}]`;
    }

    case "ZodObject":
      return zodObjectToTypeString(def.shape(), depth + 1);

    case "ZodRecord": {
      const keyType = def.keyType ? zodToTypeString(def.keyType, depth + 1) : "string";
      const valueType = zodToTypeString(def.valueType, depth + 1);
      return `Record<${keyType}, ${valueType}>`;
    }

    case "ZodMap": {
      const keyType = zodToTypeString(def.keyType, depth + 1);
      const valueType = zodToTypeString(def.valueType, depth + 1);
      return `Map<${keyType}, ${valueType}>`;
    }

    case "ZodSet":
      return `Set<${zodToTypeString(def.valueType, depth + 1)}>`;

    // Union / Intersection
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = def.options.map((opt: unknown) => zodToTypeString(opt, depth + 1));
      return options.join(" | ");
    }

    case "ZodIntersection": {
      const left = zodToTypeString(def.left, depth + 1);
      const right = zodToTypeString(def.right, depth + 1);
      return `${left} & ${right}`;
    }

    // Modifiers
    case "ZodOptional":
      return zodToTypeString(def.innerType, depth + 1);

    case "ZodNullable":
      return `${zodToTypeString(def.innerType, depth + 1)} | null`;

    case "ZodDefault":
    case "ZodCatch":
    case "ZodReadonly":
    case "ZodBranded":
    case "ZodPipeline":
      return zodToTypeString(def.innerType ?? def.in, depth + 1);

    case "ZodLazy":
      // Lazy types can cause infinite recursion, return unknown
      return "unknown";

    case "ZodEffects":
      // Effects (transform/refine) - use the output schema if available
      return zodToTypeString(def.schema, depth + 1);

    case "ZodPromise":
      return `Promise<${zodToTypeString(def.type, depth + 1)}>`;

    case "ZodFunction":
      return "Function";

    default:
      return "unknown";
  }
}

/**
 * Convert a Zod object schema's shape to TypeScript interface fields.
 */
function zodObjectToTypeString(shape: Record<string, unknown>, depth: number): string {
  const fields: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const def = (value as any)?._def;
    const isOptional = def?.typeName === "ZodOptional";
    const hasDefault = def?.typeName === "ZodDefault";

    // Field is optional if it's ZodOptional OR has a default value
    const optionalMark = isOptional || hasDefault ? "?" : "";
    const typeStr = zodToTypeString(value, depth);
    const safeKey = toSafeKey(key);

    fields.push(`${safeKey}${optionalMark}: ${typeStr}`);
  }

  if (fields.length === 0) {
    return "Record<string, unknown>";
  }

  return `{ ${fields.join("; ")} }`;
}

/**
 * Convert any supported schema to a TypeScript type string.
 */
function schemaToTypeString(schema: unknown): string {
  const lib = detectSchemaLibrary(schema);

  switch (lib) {
    case "zod":
      return zodToTypeString(schema);

    case "valibot":
      // TODO: Implement Valibot introspection
      return "Record<string, unknown>";

    case "arktype":
      // TODO: Implement ArkType introspection
      return "Record<string, unknown>";

    default:
      return "Record<string, unknown>";
  }
}

// ---------------------------------------------------------------------------
// Type Generation
// ---------------------------------------------------------------------------

/**
 * Generate TypeScript declarations for module augmentation.
 * This enables type-safe getCollection/getEntry calls.
 */
export function generateTypes(collections: AnyCollection[]): string {
  const lines: string[] = [];

  // Header
  lines.push("// =============================================================================");
  lines.push("// Auto-generated by @usedocks/core");
  lines.push("// Do not edit this file manually - it will be overwritten on rebuild");
  lines.push("// =============================================================================");
  lines.push("");

  // Module augmentation for CollectionRegistry
  lines.push('declare module "@usedocks/core" {');
  lines.push("  interface CollectionRegistry {");

  for (const config of collections) {
    const dataType = schemaToTypeString(config.schema);

    // For transformed type, we can't infer it at codegen time
    // The user must provide it via explicit type parameter
    // We use unknown here; actual type safety comes from the config definition
    const transformedType = config.transform ? "unknown" : "undefined";

    lines.push(`    "${config.name}": {`);
    lines.push(`      data: ${dataType};`);
    lines.push(`      transformed: ${transformedType};`);
    lines.push(`    };`);
  }

  lines.push("  }");
  lines.push("}");
  lines.push("");

  // Also generate individual type exports for convenience
  lines.push("// Individual collection types for direct import");
  lines.push('declare module "@usedocks/core/collections" {');

  for (const config of collections) {
    const pascalName = toPascalCase(config.name);
    const dataType = schemaToTypeString(config.schema);

    lines.push(`  export interface ${pascalName}Data ${dataType === "Record<string, unknown>" ? "extends Record<string, unknown> {}" : `${dataType.replace(/^{/, "{\n   ").replace(/; /g, ";\n    ").replace(/}$/, "\n  }")}`}`);
    lines.push("");
  }

  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate output including types and metadata.
 */
export interface GeneratedOutput {
  /** TypeScript declaration content */
  types: string;

  /** Collection metadata for runtime */
  metadata: {
    collections: string[];
  };
}

export function generate(collections: AnyCollection[]): GeneratedOutput {
  return {
    types: generateTypes(collections),
    metadata: {
      collections: collections.map((c) => c.name),
    },
  };
}
```

### Pipeline Implementation

Each stage is implemented as a separate module, enabling independent testing and composition.

#### Stage 1: Config (`config.ts`)

```typescript
// ============================================================================
// packages/core/src/config.ts
// ============================================================================

import { access } from "node:fs/promises";
import path from "node:path";
import type { AnyCollection, EngineConfig } from "./types";

export const CONFIG_FILE_NAMES = [
  "docks.config.ts",
  "docks.config.js",
  "docks.config.mjs",
] as const;

export interface ResolvedConfig {
  /** Absolute path to config file (if found) */
  configPath: string | null;

  /** Working directory */
  cwd: string;

  /** Resolved collection configs */
  collections: AnyCollection[];

  /** Validation mode */
  mode: "development" | "production";
}

/**
 * Resolve and load configuration.
 */
export async function resolveConfig(cwd: string): Promise<ResolvedConfig> {
  // Find config file
  let configPath: string | null = null;
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(cwd, name);
    try {
      await access(candidate);
      configPath = candidate;
      break;
    } catch {
      // Continue to next candidate
    }
  }

  if (!configPath) {
    throw new Error(
      `No docks.config.{ts,js,mjs} found in ${cwd}. ` +
      `Create a config file with defineConfig({ collections: [...] })`
    );
  }

  // Load config via jiti (supports TypeScript)
  const { createJiti } = await import("jiti");
  const jiti = createJiti(configPath);
  const mod = await jiti.import(configPath);
  const config = (mod as { default?: EngineConfig }).default ?? mod as EngineConfig;

  if (!config.collections || !Array.isArray(config.collections)) {
    throw new Error(
      `Invalid config: "collections" must be an array of collection definitions`
    );
  }

  return {
    configPath,
    cwd,
    collections: config.collections,
    mode: config.mode ?? "development",
  };
}
```

#### Stage 2: Collector (`collector.ts`)

```typescript
// ============================================================================
// packages/core/src/collector.ts (NEW FILE)
// ============================================================================

import { stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AnyCollection, ResolvedConfig } from "./types";

export interface CollectedFile {
  /** Absolute file path */
  absolutePath: string;

  /** Path relative to collection directory */
  relativePath: string;

  /** Collection this file belongs to */
  collection: AnyCollection;
}

/**
 * Collect files from all configured collections.
 * Returns files grouped by collection for parallel processing.
 */
export async function collect(config: ResolvedConfig): Promise<CollectedFile[]> {
  const files: CollectedFile[] = [];

  // Process collections in parallel
  await Promise.all(
    config.collections.map(async (collection) => {
      const collectionFiles = await collectCollection(collection, config.cwd);
      files.push(...collectionFiles);
    })
  );

  return files;
}

/**
 * Collect files for a single collection.
 */
async function collectCollection(
  collection: AnyCollection,
  cwd: string
): Promise<CollectedFile[]> {
  const absoluteDir = path.isAbsolute(collection.directory)
    ? collection.directory
    : path.join(cwd, collection.directory);

  // Verify directory exists
  try {
    const stats = await stat(absoluteDir);
    if (!stats.isDirectory()) {
      console.warn(
        `[docks] "${collection.directory}" is not a directory, ` +
        `skipping collection "${collection.name}"`
      );
      return [];
    }
  } catch {
    console.warn(
      `[docks] Directory "${collection.directory}" not found, ` +
      `skipping collection "${collection.name}"`
    );
    return [];
  }

  // Build glob patterns
  const include = normalizePatterns(collection.include, "**/*.md");
  const exclude = normalizePatterns(collection.exclude, undefined) ?? [];

  // Find matching files
  const paths = await fg(include, {
    cwd: absoluteDir,
    absolute: true,
    ignore: ["**/node_modules/**", ...exclude],
  });

  return paths.map((absolutePath) => ({
    absolutePath,
    relativePath: path.relative(absoluteDir, absolutePath),
    collection,
  }));
}

function normalizePatterns(
  patterns: string | string[] | undefined,
  defaultPattern: string | undefined
): string[] | undefined {
  if (!patterns) {
    return defaultPattern ? [defaultPattern] : undefined;
  }
  return Array.isArray(patterns) ? patterns : [patterns];
}
```

#### Stage 3: Parser (`parser.ts`)

```typescript
// ============================================================================
// packages/core/src/parser.ts
// ============================================================================

import { readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { CollectedFile, Document, DocumentMeta, CollectionSchema } from "./types";
import { ValidationError } from "./types";

export interface ParsedDocument {
  /** The collected file this was parsed from */
  file: CollectedFile;

  /** Parsed document with validated data */
  document: Document;

  /** Derived slug */
  slug: string;
}

/**
 * Parse multiple files in parallel.
 */
export async function parse(files: CollectedFile[]): Promise<ParsedDocument[]> {
  const results = await Promise.allSettled(
    files.map((file) => parseFile(file))
  );

  const parsed: ParsedDocument[] = [];
  const errors: ValidationError[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      parsed.push(result.value);
    } else {
      if (result.reason instanceof ValidationError) {
        errors.push(result.reason);
      } else {
        throw result.reason;
      }
    }
  }

  // Return parsed documents; errors are collected for reporting
  return parsed;
}

/**
 * Parse a single file.
 */
async function parseFile(file: CollectedFile): Promise<ParsedDocument> {
  const content = await readFile(file.absolutePath, "utf-8");
  const { data, content: body } = matter(content);

  // Validate against schema
  const validatedData = await validateSchema(
    file.collection.schema,
    data,
    file.absolutePath,
    file.collection.name
  );

  const meta = buildMeta(file.relativePath);
  const slug = deriveSlug(file.relativePath);

  return {
    file,
    document: {
      data: validatedData,
      content: body,
      _meta: meta,
    },
    slug,
  };
}

/**
 * Validate data against a Standard Schema.
 */
async function validateSchema(
  schema: CollectionSchema,
  data: unknown,
  filePath: string,
  collection: string
): Promise<Record<string, unknown>> {
  const result = schema["~standard"].validate(data);

  // Handle async validators
  const resolved = result instanceof Promise ? await result : result;

  if (resolved.issues) {
    throw new ValidationError(
      resolved.issues.map((issue) => ({
        message: issue.message,
        path: issue.path as PropertyKey[] | undefined,
      })),
      filePath,
      collection
    );
  }

  return resolved.value as Record<string, unknown>;
}

function buildMeta(relativePath: string): DocumentMeta {
  const parsed = path.parse(relativePath);
  return {
    path: relativePath,
    fileName: parsed.name,
    extension: parsed.ext.slice(1),
    directory: parsed.dir || ".",
  };
}

function deriveSlug(relativePath: string): string {
  const parsed = path.parse(relativePath);

  // index.md uses parent directory name
  if (parsed.name === "index") {
    const dir = path.dirname(relativePath);
    return dir === "." ? "index" : dir.split(path.sep).pop()!;
  }

  // Remove extension, preserve nested path
  return relativePath.replace(/\.[^.]+$/, "");
}
```

#### Stage 4: Transformer (`transformer.ts`)

```typescript
// ============================================================================
// packages/core/src/transformer.ts (NEW FILE)
// ============================================================================

import pLimit from "p-limit";
import { createContextStore, createTransformContext, SkipDocumentError } from "./context";
import type { AnyCollection, Entry, ParsedDocument, ResolvedConfig } from "./types";

// Limit concurrent transforms (CPU bound)
const limit = pLimit(Math.max(1, (navigator?.hardwareConcurrency ?? 4) - 1));

export interface TransformResult {
  /** Successfully transformed entries */
  entries: Entry[];

  /** Skipped document paths */
  skipped: string[];

  /** Transform errors (in development mode) */
  errors: TransformError[];
}

export class TransformError extends Error {
  constructor(
    public readonly entryId: string,
    public readonly filePath: string,
    public readonly cause: unknown
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Transform failed for "${entryId}": ${message}`);
    this.name = "TransformError";
  }
}

/**
 * Transform parsed documents into entries.
 * Processes collections in order to enable context.documents().
 */
export async function transform(
  documents: ParsedDocument[],
  config: ResolvedConfig
): Promise<TransformResult> {
  const entries: Entry[] = [];
  const skipped: string[] = [];
  const errors: TransformError[] = [];

  // Group documents by collection
  const byCollection = new Map<string, ParsedDocument[]>();
  for (const doc of documents) {
    const name = doc.file.collection.name;
    if (!byCollection.has(name)) {
      byCollection.set(name, []);
    }
    byCollection.get(name)!.push(doc);
  }

  // Shared context store (enables cross-collection access)
  const contextStore = createContextStore();

  // Process collections in config order
  for (const collection of config.collections) {
    const collectionDocs = byCollection.get(collection.name) ?? [];
    const collectionEntries: Entry[] = [];

    // Transform documents in parallel (within collection)
    const results = await Promise.all(
      collectionDocs.map((doc) =>
        limit(() => transformDocument(doc, collection, contextStore, config.mode))
      )
    );

    for (const result of results) {
      if (result.type === "success") {
        collectionEntries.push(result.entry);
        entries.push(result.entry);
      } else if (result.type === "skipped") {
        skipped.push(result.path);
      } else if (result.type === "error") {
        if (config.mode === "production") {
          throw result.error;
        }
        errors.push(result.error);
      }
    }

    // Store collection entries for context.documents()
    contextStore.collections.set(collection.name, collectionEntries);
  }

  return { entries, skipped, errors };
}

type TransformDocResult =
  | { type: "success"; entry: Entry }
  | { type: "skipped"; path: string }
  | { type: "error"; error: TransformError };

async function transformDocument(
  doc: ParsedDocument,
  collection: AnyCollection,
  contextStore: ReturnType<typeof createContextStore>,
  mode: "development" | "production"
): Promise<TransformDocResult> {
  const entryId = `${collection.name}/${doc.slug}`;

  try {
    let transformed: Record<string, unknown> | undefined;

    if (collection.transform) {
      const context = createTransformContext(
        collection.name,
        collection.directory,
        doc.file.absolutePath,
        contextStore
      );

      const result = await collection.transform(doc.document, context);
      transformed = result as Record<string, unknown> | undefined;
    }

    const entry: Entry = {
      id: entryId,
      slug: doc.slug,
      collection: collection.name,
      data: doc.document.data,
      content: doc.document.content,
      _meta: doc.document._meta,
      transformed,
    };

    return { type: "success", entry };
  } catch (error) {
    if (error instanceof SkipDocumentError) {
      return { type: "skipped", path: doc.file.absolutePath };
    }

    return {
      type: "error",
      error: new TransformError(entryId, doc.file.absolutePath, error),
    };
  }
}
```

#### Stage 5: Writer (`writer.ts`)

```typescript
// ============================================================================
// packages/core/src/writer.ts (NEW FILE)
// ============================================================================

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Entry, ResolvedConfig } from "./types";
import { generateTypes } from "./typegen";

export interface GeneratedOutput {
  /** Path to generated types file */
  typesPath: string;

  /** Generated type content */
  typesContent: string;
}

/**
 * Write generated types to disk.
 */
export async function write(
  entries: Entry[],
  config: ResolvedConfig,
  outDir?: string
): Promise<GeneratedOutput> {
  const dir = outDir ?? path.join(config.cwd, "node_modules", ".docks");

  // Ensure output directory exists
  await mkdir(dir, { recursive: true });

  // Generate types from config (schema-based, not data-based)
  const typesContent = generateTypes(config.collections);
  const typesPath = path.join(dir, "types.d.ts");

  await writeFile(typesPath, typesContent, "utf-8");

  return { typesPath, typesContent };
}
```

#### Pipeline Orchestrator (`pipeline.ts`)

```typescript
// ============================================================================
// packages/core/src/pipeline.ts (NEW FILE)
// ============================================================================

import { resolveConfig, type ResolvedConfig } from "./config";
import { collect, type CollectedFile } from "./collector";
import { parse, type ParsedDocument } from "./parser";
import { transform, type TransformResult } from "./transformer";
import { write, type GeneratedOutput } from "./writer";
import type { Entry } from "./types";

export interface PipelineResult {
  /** Resolved configuration */
  config: ResolvedConfig;

  /** Collected files */
  files: CollectedFile[];

  /** Parsed documents */
  documents: ParsedDocument[];

  /** Transform result */
  transformResult: TransformResult;

  /** Generated output */
  output: GeneratedOutput;

  /** Final entries (convenience) */
  entries: Entry[];
}

export interface PipelineOptions {
  /** Working directory */
  cwd?: string;

  /** Output directory for generated files */
  outDir?: string;

  /** Skip writing files (useful for testing) */
  skipWrite?: boolean;
}

/**
 * Run the full pipeline: config → collect → parse → transform → write
 */
export async function runPipeline(options: PipelineOptions = {}): Promise<PipelineResult> {
  const cwd = options.cwd ?? process.cwd();

  // Stage 1: Config
  const config = await resolveConfig(cwd);

  // Stage 2: Collect
  const files = await collect(config);

  // Stage 3: Parse
  const documents = await parse(files);

  // Stage 4: Transform
  const transformResult = await transform(documents, config);

  // Stage 5: Write
  const output = options.skipWrite
    ? { typesPath: "", typesContent: "" }
    : await write(transformResult.entries, config, options.outDir);

  return {
    config,
    files,
    documents,
    transformResult,
    output,
    entries: transformResult.entries,
  };
}

/**
 * Run pipeline stages individually (for advanced use cases).
 */
export const pipeline = {
  config: resolveConfig,
  collect,
  parse,
  transform,
  write,
  run: runPipeline,
};
```

#### Synchronizer (`synchronizer.ts`)

```typescript
// ============================================================================
// packages/core/src/synchronizer.ts (NEW FILE)
// ============================================================================

import path from "node:path";
import picomatch from "picomatch";
import type { AnyCollection, Entry, ResolvedConfig } from "./types";
import { parse } from "./parser";
import { transform } from "./transformer";

export interface SynchronizerState {
  /** Entries by ID */
  entries: Map<string, Entry>;

  /** File path to entry ID mapping */
  pathToId: Map<string, string>;

  /** Entries grouped by collection */
  byCollection: Map<string, Entry[]>;
}

export interface SyncResult {
  /** Type of change */
  type: "added" | "changed" | "deleted" | "skipped";

  /** Affected entry (if any) */
  entry?: Entry;

  /** File path */
  path: string;

  /** Collection name */
  collection: string;
}

/**
 * Create a synchronizer for incremental updates.
 */
export function createSynchronizer(config: ResolvedConfig) {
  const state: SynchronizerState = {
    entries: new Map(),
    pathToId: new Map(),
    byCollection: new Map(),
  };

  // Build matchers for each collection
  const matchers = config.collections.map((collection) => ({
    collection,
    matcher: createMatcher(collection, config.cwd),
  }));

  /**
   * Initialize state from entries.
   */
  function initialize(entries: Entry[]): void {
    state.entries.clear();
    state.pathToId.clear();
    state.byCollection.clear();

    for (const entry of entries) {
      state.entries.set(entry.id, entry);
      // Note: We don't have absolute paths in entries by design
      // The synchronizer tracks this separately

      let collectionEntries = state.byCollection.get(entry.collection);
      if (!collectionEntries) {
        collectionEntries = [];
        state.byCollection.set(entry.collection, collectionEntries);
      }
      collectionEntries.push(entry);
    }
  }

  /**
   * Handle file deletion.
   */
  function deleted(absolutePath: string): SyncResult | null {
    const collection = resolveCollection(absolutePath, matchers);
    if (!collection) return null;

    const entryId = state.pathToId.get(absolutePath);
    if (!entryId) {
      return { type: "skipped", path: absolutePath, collection: collection.name };
    }

    const entry = state.entries.get(entryId);
    state.entries.delete(entryId);
    state.pathToId.delete(absolutePath);

    const collectionEntries = state.byCollection.get(collection.name);
    if (collectionEntries) {
      const idx = collectionEntries.findIndex((e) => e.id === entryId);
      if (idx !== -1) collectionEntries.splice(idx, 1);
    }

    return { type: "deleted", entry, path: absolutePath, collection: collection.name };
  }

  /**
   * Handle file change or addition.
   */
  async function changed(absolutePath: string): Promise<SyncResult | null> {
    const collection = resolveCollection(absolutePath, matchers);
    if (!collection) return null;

    const relativePath = path.relative(
      path.isAbsolute(collection.directory)
        ? collection.directory
        : path.join(config.cwd, collection.directory),
      absolutePath
    );

    // Parse the file
    const [parsed] = await parse([{
      absolutePath,
      relativePath,
      collection,
    }]);

    if (!parsed) {
      return { type: "skipped", path: absolutePath, collection: collection.name };
    }

    // Transform
    const result = await transform([parsed], config);

    if (result.entries.length === 0) {
      // Document was skipped
      return { type: "skipped", path: absolutePath, collection: collection.name };
    }

    const entry = result.entries[0];
    const existingId = state.pathToId.get(absolutePath);
    const isNew = !existingId;

    // Update state
    if (existingId && existingId !== entry.id) {
      // Slug changed, remove old entry
      state.entries.delete(existingId);
      const oldEntries = state.byCollection.get(collection.name);
      if (oldEntries) {
        const idx = oldEntries.findIndex((e) => e.id === existingId);
        if (idx !== -1) oldEntries.splice(idx, 1);
      }
    }

    state.entries.set(entry.id, entry);
    state.pathToId.set(absolutePath, entry.id);

    let collectionEntries = state.byCollection.get(collection.name);
    if (!collectionEntries) {
      collectionEntries = [];
      state.byCollection.set(collection.name, collectionEntries);
    }

    const existingIdx = collectionEntries.findIndex((e) => e.id === entry.id);
    if (existingIdx !== -1) {
      collectionEntries[existingIdx] = entry;
    } else {
      collectionEntries.push(entry);
    }

    return {
      type: isNew ? "added" : "changed",
      entry,
      path: absolutePath,
      collection: collection.name,
    };
  }

  /**
   * Get current state.
   */
  function getState(): SynchronizerState {
    return state;
  }

  /**
   * Get all entries.
   */
  function getEntries(): Entry[] {
    return Array.from(state.entries.values());
  }

  return {
    initialize,
    deleted,
    changed,
    getState,
    getEntries,
  };
}

function resolveCollection(
  absolutePath: string,
  matchers: Array<{ collection: AnyCollection; matcher: (path: string) => boolean }>
): AnyCollection | null {
  for (const { collection, matcher } of matchers) {
    if (matcher(absolutePath)) {
      return collection;
    }
  }
  return null;
}

function createMatcher(
  collection: AnyCollection,
  cwd: string
): (absolutePath: string) => boolean {
  const baseDir = path.isAbsolute(collection.directory)
    ? collection.directory
    : path.join(cwd, collection.directory);

  const include = Array.isArray(collection.include)
    ? collection.include
    : [collection.include ?? "**/*.md"];

  const exclude = Array.isArray(collection.exclude)
    ? collection.exclude
    : collection.exclude
      ? [collection.exclude]
      : [];

  const isMatch = picomatch(include, { ignore: exclude });

  return (absolutePath: string) => {
    if (!absolutePath.startsWith(baseDir)) return false;
    const relativePath = path.relative(baseDir, absolutePath);
    return isMatch(relativePath);
  };
}
```

### Scanner Implementation

```typescript
// ============================================================================
// packages/core/src/scanner.ts (REWRITE)

import { stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { parseDocument } from "./parser";
import { createContextStore, createTransformContext, SkipDocumentError } from "./context";
import {
  ValidationError,
  type AnyCollection,
  type Collection,
  type Entry,
  type ValidationMode,
} from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanOptions {
  /** Collection configurations to process */
  collections: AnyCollection[];

  /** Working directory */
  cwd: string;

  /** Validation mode */
  mode?: ValidationMode;

  /** Callback for validation warnings */
  onValidationWarning?: (error: ValidationError) => void;

  /** Callback for slug collisions */
  onSlugCollision?: (existing: Entry, duplicate: Entry) => void;

  /** Callback for transform errors */
  onTransformError?: (error: TransformError) => void;
}

export interface ScanResult {
  collections: Map<string, Collection>;
  entries: Map<string, Entry>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TransformError extends Error {
  readonly entry: Entry;
  readonly cause: unknown;

  constructor(entryId: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Transform failed for "${entryId}": ${message}`);
    this.name = "TransformError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function normalizePatterns(patterns: string | string[] | undefined, defaultPattern: string): string[] {
  if (!patterns) return [defaultPattern];
  return Array.isArray(patterns) ? patterns : [patterns];
}

function deriveSlug(relativePath: string): string {
  const parsed = path.parse(relativePath);

  // For index files, use parent directory name
  if (parsed.name === "index") {
    const dir = path.dirname(relativePath);
    return dir === "." ? "index" : dir.split(path.sep).pop()!;
  }

  // Remove extension and use as slug
  const withoutExt = relativePath.replace(/\.[^.]+$/, "");

  // Handle nested paths: content/posts/2024/my-post.md -> 2024/my-post
  return withoutExt;
}

function buildDocumentMeta(relativePath: string) {
  const parsed = path.parse(relativePath);

  return {
    path: relativePath,
    fileName: parsed.name,
    extension: parsed.ext.slice(1), // Remove leading dot
    directory: parsed.dir || ".",
  };
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan content directories and build the content graph.
 *
 * Collections are processed in order, which matters for context.documents().
 * Earlier collections can be accessed by later ones.
 */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const {
    collections: configs,
    cwd,
    mode = "development",
    onValidationWarning,
    onSlugCollision,
    onTransformError,
  } = options;

  const collections = new Map<string, Collection>();
  const entries = new Map<string, Entry>();

  // Shared context store for cross-collection access and caching
  const contextStore = createContextStore();

  // Process collections in order
  for (const config of configs) {
    const absoluteDir = path.isAbsolute(config.directory)
      ? config.directory
      : path.join(cwd, config.directory);

    // Check if directory exists
    try {
      const stats = await stat(absoluteDir);
      if (!stats.isDirectory()) {
        console.warn(`[docks] "${config.directory}" is not a directory, skipping collection "${config.name}"`);
        continue;
      }
    } catch {
      console.warn(`[docks] Directory "${config.directory}" not found, skipping collection "${config.name}"`);
      continue;
    }

    // Build glob patterns
    const includePatterns = normalizePatterns(config.include, "**/*.md");
    const excludePatterns = normalizePatterns(config.exclude, undefined) ?? [];

    // Find matching files
    const files = await fg(includePatterns, {
      cwd: absoluteDir,
      absolute: true,
      ignore: ["**/node_modules/**", ...excludePatterns],
    });

    const collectionEntries: Entry[] = [];

    for (const filePath of files) {
      const relativePath = path.relative(absoluteDir, filePath);
      const slug = deriveSlug(relativePath);
      const entryId = `${config.name}/${slug}`;

      try {
        // Parse document with schema validation
        const document = await parseDocument(filePath, config.schema);

        // Create transform context
        const context = createTransformContext(
          config.name,
          config.directory,
          filePath,
          contextStore
        );

        // Apply transform if defined
        let transformed: Record<string, unknown> | undefined;

        if (config.transform) {
          try {
            const result = await config.transform(
              {
                data: document.data,
                content: document.content,
                _meta: buildDocumentMeta(relativePath),
              },
              context
            );
            transformed = result as Record<string, unknown> | undefined;
          } catch (error) {
            // Handle skip
            if (error instanceof SkipDocumentError) {
              continue;
            }

            // Handle other transform errors
            const transformError = new TransformError(entryId, error);

            if (mode === "production") {
              throw transformError;
            }

            onTransformError?.(transformError);
            continue;
          }
        }

        // Build entry
        const entry: Entry = {
          id: entryId,
          slug,
          collection: config.name,
          data: document.data,
          content: document.content,
          _meta: buildDocumentMeta(relativePath),
          transformed,
        };

        // Check for slug collision
        const existing = entries.get(entry.id);
        if (existing) {
          onSlugCollision?.(existing, entry);
          continue; // First one wins
        }

        // Store entry
        entries.set(entry.id, entry);
        collectionEntries.push(entry);

      } catch (error) {
        if (error instanceof ValidationError) {
          if (mode === "production") {
            throw error;
          }
          onValidationWarning?.(error);
          continue;
        }

        // Re-throw unexpected errors
        throw error;
      }
    }

    // Store collection for context.documents() access
    const collection: Collection = {
      name: config.name,
      entries: collectionEntries,
    };

    collections.set(config.name, collection);
    contextStore.collections.set(config.name, collectionEntries);
  }

  return { collections, entries };
}
```

### Runtime API

```typescript
// ============================================================================
// packages/core/src/runtime.ts (SIMPLIFIED)
// ============================================================================

import { createEngine } from "./engine";
import { resolveConfigFile } from "./config";
import type {
  Collection,
  CollectionData,
  CollectionRegistry,
  CollectionTransformed,
  Engine,
  EngineConfig,
  Entry,
} from "./types";

// ---------------------------------------------------------------------------
// Global Engine Management
// ---------------------------------------------------------------------------

const RUNTIME_KEY = Symbol.for("@usedocks/core/runtime");

interface RuntimeStore {
  engine: Engine | null;
  promise: Promise<Engine> | null;
  config: EngineConfig | null;
}

function getStore(): RuntimeStore {
  const g = globalThis as unknown as Record<symbol, RuntimeStore | undefined>;
  if (!g[RUNTIME_KEY]) {
    g[RUNTIME_KEY] = { engine: null, promise: null, config: null };
  }
  return g[RUNTIME_KEY];
}

async function loadConfig(configPath: string): Promise<EngineConfig> {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(configPath);
  const mod = await jiti.import(configPath);
  const config = (mod as { default?: unknown }).default ?? mod;

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid config at ${configPath}: expected object with collections array`);
  }

  return config as EngineConfig;
}

async function initEngine(cwd = process.cwd()): Promise<Engine> {
  const store = getStore();

  if (store.engine) return store.engine;
  if (store.promise) return store.promise;

  store.promise = (async () => {
    let config: EngineConfig;

    if (store.config) {
      config = { ...store.config, cwd: store.config.cwd ?? cwd };
    } else {
      const resolved = await resolveConfigFile(cwd);
      if (resolved) {
        config = { ...(await loadConfig(resolved.path)), cwd };
      } else {
        throw new Error(
          "No docks.config.{ts,js,mjs} found. " +
          "Create a config file or use setRuntimeConfig() before calling getCollection/getEntry."
        );
      }
    }

    const engine = createEngine(config);
    await engine.scan();
    return engine;
  })();

  try {
    store.engine = await store.promise;
    return store.engine;
  } finally {
    store.promise = null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set runtime configuration explicitly.
 * Must be called before getCollection/getEntry if not using config file.
 */
export function setRuntimeConfig(config: EngineConfig): void {
  const store = getStore();
  store.config = config;
  store.engine = null;
  store.promise = null;
}

/**
 * Get the runtime engine instance.
 * Primarily for advanced use cases and testing.
 */
export async function getRuntimeEngine(cwd?: string): Promise<Engine> {
  return initEngine(cwd);
}

/**
 * Invalidate the cached engine.
 * Next API call will re-initialize from config.
 */
export function invalidateRuntimeEngine(): void {
  const store = getStore();
  store.engine = null;
  store.promise = null;
  store.config = null;
}

/**
 * Get a single entry by collection and slug.
 *
 * @example
 * ```ts
 * const post = await getEntry("posts", "hello-world");
 * if (post) {
 *   console.log(post.data.title);
 *   console.log(post.transformed?.readingTime);
 * }
 * ```
 */
export async function getEntry<K extends keyof CollectionRegistry>(
  collection: K,
  slug: string
): Promise<Entry<CollectionData<K>, CollectionTransformed<K>> | undefined>;
export async function getEntry(
  collection: string,
  slug: string
): Promise<Entry | undefined>;
export async function getEntry(
  collection: string,
  slug: string
): Promise<Entry | undefined> {
  const engine = await initEngine();
  return engine.getEntry(collection, slug);
}

/**
 * Get all entries in a collection.
 *
 * @example
 * ```ts
 * const posts = await getCollection("posts");
 * for (const post of posts) {
 *   console.log(post.data.title);
 * }
 * ```
 */
export async function getCollection<K extends keyof CollectionRegistry>(
  name: K
): Promise<Entry<CollectionData<K>, CollectionTransformed<K>>[]>;
export async function getCollection(name: string): Promise<Entry[]>;
export async function getCollection(name: string): Promise<Entry[]> {
  const engine = await initEngine();
  return engine.getCollection(name);
}

/**
 * Get all collections.
 */
export async function getCollections(): Promise<Collection[]> {
  const engine = await initEngine();
  return engine.getCollections();
}
```

---

## Migration Guide

### Before (Current API)

```typescript
// docks.config.ts
import { defineConfig, defineCollection } from "@usedocks/next";
import { z } from "zod";

export default defineConfig({
  roots: ["content"],
  collections: {
    posts: defineCollection({
      schema: z.object({
        title: z.string(),
        publishedAt: z.coerce.date(),
      }),
      transform: (entry) => ({
        readingTime: Math.ceil(entry.content.split(/\s+/).length / 200),
      }),
    }),
  },
});
```

```typescript
// app/blog/page.tsx
import { getAllPosts } from ".docks";
// or
import { getCollection } from "@usedocks/core";
const posts = await getCollection("posts");
```

### After (New API)

```typescript
// docks.config.ts
import { defineConfig, defineCollection } from "@usedocks/core";
import { z } from "zod";

const PostSchema = z.object({
  title: z.string(),
  publishedAt: z.coerce.date(),
  draft: z.boolean().default(false),
});

type PostTransformed = {
  readingTime: number;
  excerpt: string;
};

const posts = defineCollection<typeof PostSchema, PostTransformed>({
  name: "posts",
  directory: "content/posts",
  include: "**/*.md",
  exclude: ["**/drafts/**"],
  schema: PostSchema,
  transform: (doc, ctx) => {
    // Skip drafts in production
    if (doc.data.draft && process.env.NODE_ENV === "production") {
      ctx.skip();
    }

    return {
      readingTime: Math.ceil(doc.content.split(/\s+/).length / 200),
      excerpt: doc.content.slice(0, 200) + "...",
    };
  },
});

export default defineConfig({
  collections: [posts],
});
```

```typescript
// app/blog/page.tsx
import { getCollection } from "@usedocks/core";

export default async function BlogPage() {
  // Fully typed: Entry<PostData, PostTransformed>[]
  const posts = await getCollection("posts");

  return (
    <ul>
      {posts.map((post) => (
        <li key={post.id}>
          <h2>{post.data.title}</h2>
          <p>{post.transformed.excerpt}</p>
        </li>
      ))}
    </ul>
  );
}
```

### Key Changes

| Aspect | Before | After |
|--------|--------|-------|
| Collection definition | Object with implicit names | Array with explicit `name` |
| Content location | `roots` + folder structure | `directory` per collection |
| Transform signature | `(entry) => result` | `(doc, ctx) => result` |
| Transform types | Inferred from data | Explicit type parameter |
| Imports | Multiple sources | Single `@usedocks/core` |
| Legacy module-based imports | Special import path | Removed |

---

## Examples

### Basic Blog

```typescript
// docks.config.ts
import { defineConfig, defineCollection } from "@usedocks/core";
import { z } from "zod";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    publishedAt: z.coerce.date(),
    tags: z.array(z.string()).default([]),
  }),
});

export default defineConfig({
  collections: [posts],
});
```

### Blog with Authors (Cross-Collection Reference)

```typescript
// docks.config.ts
import { defineConfig, defineCollection } from "@usedocks/core";
import { z } from "zod";

// Authors must be defined first to be accessible in posts transform
const authors = defineCollection({
  name: "authors",
  directory: "content/authors",
  schema: z.object({
    name: z.string(),
    avatar: z.string().url().optional(),
    twitter: z.string().optional(),
  }),
});

type PostTransformed = {
  author: { name: string; avatar?: string } | null;
  readingTime: number;
};

const posts = defineCollection<typeof PostSchema, PostTransformed>({
  name: "posts",
  directory: "content/posts",
  schema: z.object({
    title: z.string(),
    authorSlug: z.string(),
    publishedAt: z.coerce.date(),
  }),
  transform: (doc, ctx) => {
    // Access authors collection (defined earlier)
    const allAuthors = ctx.documents(authors);
    const author = allAuthors.find((a) => a.slug === doc.data.authorSlug);

    return {
      author: author ? { name: author.data.name, avatar: author.data.avatar } : null,
      readingTime: Math.ceil(doc.content.split(/\s+/).length / 200),
    };
  },
});

export default defineConfig({
  collections: [authors, posts], // Order matters!
});
```

### Documentation with Caching

```typescript
// docks.config.ts
import { defineConfig, defineCollection } from "@usedocks/core";
import { z } from "zod";

type DocTransformed = {
  headings: Array<{ level: number; text: string; slug: string }>;
  wordCount: number;
};

const docs = defineCollection<typeof DocSchema, DocTransformed>({
  name: "docs",
  directory: "content/docs",
  include: "**/*.{md,mdx}",
  schema: z.object({
    title: z.string(),
    section: z.string(),
    order: z.number().default(0),
  }),
  transform: async (doc, ctx) => {
    // Cache heading extraction (expensive regex operations)
    const headings = await ctx.cache(`headings:${doc._meta.fileName}`, () => {
      const matches = doc.content.matchAll(/^(#{1,6})\s+(.+)$/gm);
      return Array.from(matches).map((match) => ({
        level: match[1].length,
        text: match[2],
        slug: match[2].toLowerCase().replace(/\s+/g, "-"),
      }));
    });

    return {
      headings,
      wordCount: doc.content.split(/\s+/).length,
    };
  },
});

export default defineConfig({
  collections: [docs],
});
```

### Conditional Content with Skip

```typescript
// docks.config.ts
import { defineConfig, defineCollection } from "@usedocks/core";
import { z } from "zod";

const posts = defineCollection({
  name: "posts",
  directory: "content/posts",
  schema: z.object({
    title: z.string(),
    draft: z.boolean().default(false),
    scheduledFor: z.coerce.date().optional(),
  }),
  transform: (doc, ctx) => {
    // Skip drafts in production
    if (doc.data.draft && process.env.NODE_ENV === "production") {
      ctx.skip();
    }

    // Skip scheduled posts that aren't published yet
    if (doc.data.scheduledFor && doc.data.scheduledFor > new Date()) {
      ctx.skip();
    }

    return {};
  },
});

export default defineConfig({
  collections: [posts],
});
```

---

## Files to Modify

### @usedocks/core (`packages/core/src/`)

| File | Action | Description |
|------|--------|-------------|
| `types.ts` | Rewrite | New CollectionConfig, TransformContext, Document types |
| `config.ts` | Update | Enhanced config resolution with validation |
| `collector.ts` | Create | Stage 2: File collection with glob patterns |
| `parser.ts` | Update | Stage 3: Parse with schema validation |
| `transformer.ts` | Create | Stage 4: Transform with context and concurrency |
| `writer.ts` | Create | Stage 5: Type generation output |
| `context.ts` | Create | TransformContext implementation |
| `synchronizer.ts` | Create | Incremental update handling for watch mode |
| `pipeline.ts` | Create | Pipeline orchestrator |
| `typegen.ts` | Rewrite | Schema-based type extraction (Zod introspection) |
| `engine.ts` | Rewrite | Use pipeline stages, manage synchronizer |
| `runtime.ts` | Simplify | Single API pattern |
| `virtual.ts` | Delete | No longer needed |
| `scanner.ts` | Delete | Replaced by pipeline stages |
| `index.ts` | Update | Export new pipeline API |

### @usedocks/next (`packages/next/src/`)

| File | Action | Description |
|------|--------|-------------|
| `plugin.ts` | Simplify | Remove legacy import mechanism |
| `loader.ts` | Delete | No longer needed |
| `index.ts` | Update | Export changes |

### Templates (`templates/next/`)

| File | Action | Description |
|------|--------|-------------|
| `docks.config.ts` | Rewrite | New config format |
| `app/blog/page.tsx` | Update | Import from @usedocks/core |
| `app/blog/[slug]/page.tsx` | Update | Import from @usedocks/core |
| `tsconfig.json` | Update | Include generated types |

---

## Implementation Order

### Phase 1: Core Types & Context (Foundation)
1. **types.ts** - New CollectionConfig, TransformContext, Document, Entry types
2. **context.ts** - TransformContext implementation with documents(), cache(), skip()

### Phase 2: Pipeline Stages
3. **config.ts** - Stage 1: Config resolution with jiti
4. **collector.ts** - Stage 2: File collection with glob patterns
5. **parser.ts** - Stage 3: Parse and validate with schema
6. **transformer.ts** - Stage 4: Transform with context and concurrency
7. **typegen.ts** - Schema-based type extraction (Zod introspection)
8. **writer.ts** - Stage 5: Type generation output

### Phase 3: Orchestration
9. **pipeline.ts** - Pipeline orchestrator (run all stages)
10. **synchronizer.ts** - Incremental updates for watch mode
11. **engine.ts** - Rewrite to use pipeline and synchronizer

### Phase 4: Runtime & Exports
12. **runtime.ts** - Simplified type-safe API
13. **index.ts** - Update exports (add pipeline, remove virtual)
14. Delete **virtual.ts**
15. Delete **scanner.ts** (replaced by pipeline)

### Phase 5: Next.js Integration
16. **@usedocks/next plugin.ts** - Use pipeline, remove legacy import mechanism
17. Delete **@usedocks/next loader.ts**

### Phase 6: Template & Docs
18. **templates/next/docks.config.ts** - New config format
19. **templates/next/app/blog/*.tsx** - Update imports
20. **templates/next/tsconfig.json** - Include generated types

---

## Testing Checklist

### Pipeline Stages
- [ ] **Config**: Finds and loads docks.config.{ts,js,mjs}
- [ ] **Config**: Throws descriptive error if no config found
- [ ] **Config**: Validates collections array structure
- [ ] **Collector**: Finds files matching include patterns
- [ ] **Collector**: Excludes files matching exclude patterns
- [ ] **Collector**: Handles missing directories gracefully
- [ ] **Parser**: Parses frontmatter correctly
- [ ] **Parser**: Validates against schema
- [ ] **Parser**: Returns ValidationError with path info
- [ ] **Transformer**: Calls transform function with document
- [ ] **Transformer**: Provides working TransformContext
- [ ] **Transformer**: Handles concurrent transforms (p-limit)
- [ ] **Writer**: Generates types.d.ts with correct content
- [ ] **Writer**: Creates output directory if needed

### Transform Context
- [ ] `context.documents()` returns typed entries from earlier collections
- [ ] `context.documents()` throws for undefined collections
- [ ] `context.documents()` throws for later-defined collections (helpful error)
- [ ] `context.cache()` memoizes by key
- [ ] `context.cache()` namespaces keys by collection
- [ ] `context.skip()` excludes document from output
- [ ] `context.collection` has correct name and directory
- [ ] `context.filePath` is absolute path

### Type Generation
- [ ] Zod string → `string`
- [ ] Zod number → `number`
- [ ] Zod boolean → `boolean`
- [ ] Zod date → `Date`
- [ ] Zod array → `T[]`
- [ ] Zod object → `{ field: type }`
- [ ] Zod optional → `field?: type`
- [ ] Zod default → `field?: type` (optional)
- [ ] Zod enum → `"a" | "b" | "c"`
- [ ] Zod union → `A | B`
- [ ] Zod nullable → `type | null`
- [ ] Unknown schemas → `Record<string, unknown>`

### Synchronizer (Watch Mode)
- [ ] `initialize()` populates state from entries
- [ ] `changed()` adds new files to state
- [ ] `changed()` updates existing files in state
- [ ] `changed()` handles slug changes (removes old, adds new)
- [ ] `deleted()` removes files from state
- [ ] `deleted()` removes empty collections
- [ ] Resolves correct collection for file path

### Runtime API
- [ ] `getCollection("posts")` returns typed array
- [ ] `getEntry("posts", "slug")` returns typed entry or undefined
- [ ] `getCollections()` returns all collections
- [ ] Auto-initializes engine on first call
- [ ] `setRuntimeConfig()` overrides file config
- [ ] `invalidateRuntimeEngine()` forces re-initialization

### Integration
- [ ] Full pipeline runs without errors
- [ ] Generated types provide IDE autocomplete
- [ ] Watch mode detects file changes
- [ ] Watch mode regenerates types
- [ ] Next.js plugin integrates correctly
- [ ] Template app builds and runs
