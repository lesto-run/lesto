# Milestone 1: Core Types & Transform Context

## Objective
Establish the new type system foundation and implement TransformContext.

## Deliverables
- [ ] `types.ts` - New type definitions
- [ ] `context.ts` - TransformContext implementation
- [ ] Tests for TransformContext

## Files to Create/Modify

### 1. `packages/core/src/types.ts` (Rewrite)

```typescript
import type { StandardSchemaV1 } from "@standard-schema/spec";

// =============================================================================
// Schema Utilities
// =============================================================================

export type InferOutput<T> = T extends StandardSchemaV1<unknown, infer O> ? O : never;

export type CollectionSchema = StandardSchemaV1<
  Record<string, unknown>,
  Record<string, unknown>
>;

// =============================================================================
// Document Types
// =============================================================================

export interface DocumentMeta {
  path: string;
  fileName: string;
  extension: string;
  directory: string;
}

export interface Document<TData extends Record<string, unknown> = Record<string, unknown>> {
  readonly data: TData;
  readonly content: string;
  readonly _meta: DocumentMeta;
}

// =============================================================================
// Entry Types
// =============================================================================

export interface Entry<
  TData extends Record<string, unknown> = Record<string, unknown>,
  TTransformed extends Record<string, unknown> | undefined = undefined,
> {
  readonly id: string;
  readonly slug: string;
  readonly collection: string;
  readonly data: TData;
  readonly content: string;
  readonly _meta: DocumentMeta;
  readonly transformed: TTransformed;
}

// =============================================================================
// Transform Context
// =============================================================================

export interface TransformContext {
  documents<T extends AnyCollection>(collection: T): InferEntry<T>[];
  cache<T>(key: string, fn: () => T | Promise<T>): Promise<T>;
  skip(): never;
  readonly collection: { name: string; directory: string };
  readonly filePath: string;
}

export type TransformFn<
  TData extends Record<string, unknown> = Record<string, unknown>,
  TTransformed extends Record<string, unknown> | undefined = undefined,
> = (
  document: Document<TData>,
  context: TransformContext
) => TTransformed extends undefined ? void : TTransformed | Promise<TTransformed>;

// =============================================================================
// Collection Config
// =============================================================================

export interface CollectionConfig<
  TSchema extends CollectionSchema = CollectionSchema,
  TTransformed extends Record<string, unknown> | undefined = undefined,
> {
  name: string;
  directory: string;
  include?: string | string[];
  exclude?: string | string[];
  schema: TSchema;
  transform?: TransformFn<InferOutput<TSchema>, TTransformed>;
}

export type AnyCollection = CollectionConfig<CollectionSchema, Record<string, unknown> | undefined>;

export type InferEntry<T extends AnyCollection> = Entry<
  InferOutput<T["schema"]>,
  T extends CollectionConfig<CollectionSchema, infer R> ? R : undefined
>;

// =============================================================================
// Engine Config
// =============================================================================

export type ValidationMode = "development" | "production";

export interface EngineConfig<TCollections extends AnyCollection[] = AnyCollection[]> {
  cwd?: string;
  collections: TCollections;
  mode?: ValidationMode;
  onValidationWarning?: (error: ValidationError) => void;
  onSlugCollision?: (existing: Entry, duplicate: Entry) => void;
  onTransformError?: (error: TransformError) => void;
}

// =============================================================================
// Collection Registry (Module Augmentation)
// =============================================================================

export interface CollectionRegistry {}

export type CollectionData<K extends keyof CollectionRegistry> =
  CollectionRegistry[K] extends { data: infer D } ? D : Record<string, unknown>;

export type CollectionTransformed<K extends keyof CollectionRegistry> =
  CollectionRegistry[K] extends { transformed: infer T } ? T : undefined;

// =============================================================================
// Errors
// =============================================================================

export interface ValidationIssue {
  message: string;
  path?: ReadonlyArray<PropertyKey>;
}

export class ValidationError extends Error {
  readonly issues: ValidationIssue[];
  readonly filePath: string;
  readonly collection: string;

  constructor(issues: ValidationIssue[], filePath: string, collection: string) {
    const formatIssue = (issue: ValidationIssue) => {
      const path = issue.path?.map(String).join(".") || "root";
      return `  - ${path}: ${issue.message}`;
    };
    super(`Validation failed in "${collection}" at ${filePath}:\n${issues.map(formatIssue).join("\n")}`);
    this.name = "ValidationError";
    this.issues = issues;
    this.filePath = filePath;
    this.collection = collection;
  }
}

export class TransformError extends Error {
  readonly entryId: string;
  readonly filePath: string;
  readonly cause: unknown;

  constructor(entryId: string, filePath: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Transform failed for "${entryId}": ${message}`);
    this.name = "TransformError";
    this.entryId = entryId;
    this.filePath = filePath;
    this.cause = cause;
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

export function defineCollection<
  TSchema extends CollectionSchema,
  TTransformed extends Record<string, unknown> | undefined = undefined,
>(config: CollectionConfig<TSchema, TTransformed>): CollectionConfig<TSchema, TTransformed> {
  return config;
}

export function defineConfig<TCollections extends AnyCollection[]>(
  config: EngineConfig<TCollections>
): EngineConfig<TCollections> {
  return config;
}
```

### 2. `packages/core/src/context.ts` (New File)

```typescript
import type { AnyCollection, Entry, InferEntry, TransformContext } from "./types";

export class SkipDocumentError extends Error {
  constructor() {
    super("Document skipped via context.skip()");
    this.name = "SkipDocumentError";
  }
}

export interface ContextStore {
  cache: Map<string, unknown>;
  collections: Map<string, Entry[]>;
}

export function createContextStore(): ContextStore {
  return {
    cache: new Map(),
    collections: new Map(),
  };
}

export function createTransformContext(
  collectionName: string,
  collectionDirectory: string,
  filePath: string,
  store: ContextStore
): TransformContext {
  return {
    documents<T extends AnyCollection>(collection: T): InferEntry<T>[] {
      const entries = store.collections.get(collection.name);
      if (!entries) {
        throw new Error(
          `Collection "${collection.name}" not found. ` +
          `Ensure it appears before "${collectionName}" in your collections array.`
        );
      }
      return entries as InferEntry<T>[];
    },

    async cache<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
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

## Tests

### `packages/core/src/__tests__/context.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  createContextStore,
  createTransformContext,
  SkipDocumentError,
} from "../context";

describe("TransformContext", () => {
  let store: ReturnType<typeof createContextStore>;

  beforeEach(() => {
    store = createContextStore();
  });

  describe("documents()", () => {
    it("returns entries from earlier collections", () => {
      const entries = [
        { id: "authors/john", slug: "john", collection: "authors", data: { name: "John" } },
      ];
      store.collections.set("authors", entries as any);

      const ctx = createTransformContext("posts", "content/posts", "/path/to/file.md", store);
      const mockCollection = { name: "authors" } as any;

      const result = ctx.documents(mockCollection);
      expect(result).toBe(entries);
    });

    it("throws for undefined collections", () => {
      const ctx = createTransformContext("posts", "content/posts", "/path/to/file.md", store);
      const mockCollection = { name: "unknown" } as any;

      expect(() => ctx.documents(mockCollection)).toThrow('Collection "unknown" not found');
    });

    it("error message suggests ordering fix", () => {
      const ctx = createTransformContext("posts", "content/posts", "/path/to/file.md", store);
      const mockCollection = { name: "authors" } as any;

      expect(() => ctx.documents(mockCollection)).toThrow(
        'Ensure it appears before "posts" in your collections array'
      );
    });
  });

  describe("cache()", () => {
    it("memoizes by key", async () => {
      const ctx = createTransformContext("posts", "content/posts", "/path/to/file.md", store);
      let callCount = 0;

      const result1 = await ctx.cache("test", () => {
        callCount++;
        return "value";
      });
      const result2 = await ctx.cache("test", () => {
        callCount++;
        return "different";
      });

      expect(result1).toBe("value");
      expect(result2).toBe("value");
      expect(callCount).toBe(1);
    });

    it("namespaces keys by collection", async () => {
      const ctx1 = createTransformContext("posts", "content/posts", "/path/to/file.md", store);
      const ctx2 = createTransformContext("pages", "content/pages", "/path/to/file.md", store);

      await ctx1.cache("key", () => "posts-value");
      await ctx2.cache("key", () => "pages-value");

      expect(store.cache.get("posts:key")).toBe("posts-value");
      expect(store.cache.get("pages:key")).toBe("pages-value");
    });

    it("handles async functions", async () => {
      const ctx = createTransformContext("posts", "content/posts", "/path/to/file.md", store);

      const result = await ctx.cache("async", async () => {
        return new Promise((resolve) => setTimeout(() => resolve("async-value"), 10));
      });

      expect(result).toBe("async-value");
    });
  });

  describe("skip()", () => {
    it("throws SkipDocumentError", () => {
      const ctx = createTransformContext("posts", "content/posts", "/path/to/file.md", store);

      expect(() => ctx.skip()).toThrow(SkipDocumentError);
    });
  });

  describe("collection property", () => {
    it("has correct name and directory", () => {
      const ctx = createTransformContext("posts", "content/posts", "/path/to/file.md", store);

      expect(ctx.collection.name).toBe("posts");
      expect(ctx.collection.directory).toBe("content/posts");
    });
  });

  describe("filePath property", () => {
    it("returns the file path", () => {
      const ctx = createTransformContext("posts", "content/posts", "/path/to/file.md", store);

      expect(ctx.filePath).toBe("/path/to/file.md");
    });
  });
});

describe("SkipDocumentError", () => {
  it("has correct name", () => {
    const error = new SkipDocumentError();
    expect(error.name).toBe("SkipDocumentError");
  });

  it("has descriptive message", () => {
    const error = new SkipDocumentError();
    expect(error.message).toBe("Document skipped via context.skip()");
  });
});
```

## Acceptance Criteria

- [ ] `types.ts` compiles without errors
- [ ] `context.ts` compiles without errors
- [ ] All TransformContext tests pass
- [ ] `defineCollection` and `defineConfig` work with type inference
- [ ] Can create collections with explicit transform type parameter

## Notes

- The `Entry.transformed` type is now always defined (not optional) - use `undefined` for no transform
