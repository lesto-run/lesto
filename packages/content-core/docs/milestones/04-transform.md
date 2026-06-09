# Milestone 4: Pipeline - Transform

## Objective
Implement the transform stage with TransformContext, concurrency control, and skip handling.

## Dependencies
- Milestone 1 (types, context)
- Milestone 3 (parser)

## Deliverables
- [ ] `transformer.ts` - Transform with context and concurrency
- [ ] Tests for transform functionality

## Files to Create

### `packages/core/src/transformer.ts` (New File)

```typescript
import pLimit from "p-limit";
import { createContextStore, createTransformContext, SkipDocumentError, type ContextStore } from "./context";
import type { ParsedDocument } from "./parser";
import type { ResolvedConfig } from "./config";
import type { AnyCollection, Entry, TransformError as TransformErrorType } from "./types";
import { TransformError } from "./types";

// Limit concurrent transforms based on CPU cores
const DEFAULT_CONCURRENCY = Math.max(1, (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4) - 1);

export interface TransformOptions {
  /** Max concurrent transforms */
  concurrency?: number;
}

export interface TransformResult {
  /** Successfully transformed entries */
  entries: Entry[];

  /** Skipped document paths */
  skipped: string[];

  /** Transform errors (development mode) */
  errors: TransformErrorType[];
}

type DocResult =
  | { type: "success"; entry: Entry }
  | { type: "skipped"; path: string }
  | { type: "error"; error: TransformErrorType };

/**
 * Transform a single document.
 */
async function transformDocument(
  doc: ParsedDocument,
  collection: AnyCollection,
  store: ContextStore,
  mode: "development" | "production"
): Promise<DocResult> {
  const entryId = `${collection.name}/${doc.slug}`;

  try {
    let transformed: Record<string, unknown> | undefined;

    if (collection.transform) {
      const context = createTransformContext(
        collection.name,
        collection.directory,
        doc.file.absolutePath,
        store
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

    const transformError = new TransformError(entryId, doc.file.absolutePath, error);

    if (mode === "production") {
      throw transformError;
    }

    return { type: "error", error: transformError };
  }
}

/**
 * Transform parsed documents into entries.
 * Processes collections in order to enable context.documents().
 */
export async function transform(
  documents: ParsedDocument[],
  config: ResolvedConfig,
  options: TransformOptions = {}
): Promise<TransformResult> {
  const { concurrency = DEFAULT_CONCURRENCY } = options;
  const limit = pLimit(concurrency);

  const entries: Entry[] = [];
  const skipped: string[] = [];
  const errors: TransformErrorType[] = [];

  // Group documents by collection
  const byCollection = new Map<string, ParsedDocument[]>();
  for (const doc of documents) {
    const name = doc.file.collection.name;
    if (!byCollection.has(name)) {
      byCollection.set(name, []);
    }
    byCollection.get(name)!.push(doc);
  }

  // Shared context store
  const store = createContextStore();

  // Process collections in config order (important for context.documents())
  for (const collection of config.collections) {
    const collectionDocs = byCollection.get(collection.name) ?? [];
    const collectionEntries: Entry[] = [];

    // Transform documents concurrently within collection
    const results = await Promise.all(
      collectionDocs.map((doc) =>
        limit(() => transformDocument(doc, collection, store, config.mode))
      )
    );

    for (const result of results) {
      switch (result.type) {
        case "success":
          collectionEntries.push(result.entry);
          entries.push(result.entry);
          break;
        case "skipped":
          skipped.push(result.path);
          break;
        case "error":
          errors.push(result.error);
          break;
      }
    }

    // Store for context.documents() in subsequent collections
    store.collections.set(collection.name, collectionEntries);
  }

  return { entries, skipped, errors };
}
```

## Tests

### `packages/core/src/__tests__/transformer.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { transform } from "../transformer";
import type { ParsedDocument } from "../parser";
import type { ResolvedConfig } from "../config";
import { TransformError } from "../types";
import { z } from "zod";

describe("transformer", () => {
  const createDoc = (
    slug: string,
    collectionName: string,
    data: Record<string, unknown> = {},
    content = ""
  ): ParsedDocument => ({
    file: {
      absolutePath: `/path/to/${slug}.md`,
      relativePath: `${slug}.md`,
      collection: {
        name: collectionName,
        directory: `content/${collectionName}`,
        schema: z.object({}),
      },
    },
    document: {
      data,
      content,
      _meta: { path: `${slug}.md`, fileName: slug, extension: "md", directory: "." },
    },
    slug,
  });

  const createConfig = (collections: any[]): ResolvedConfig => ({
    configPath: null,
    cwd: "/project",
    collections,
    mode: "development",
  });

  describe("basic transformation", () => {
    it("creates entries without transform", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
      };
      const doc = createDoc("hello", "posts", { title: "Hello" });
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].id).toBe("posts/hello");
      expect(result.entries[0].data).toEqual({ title: "Hello" });
      expect(result.entries[0].transformed).toBeUndefined();
    });

    it("applies transform function", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: (doc: any) => ({ wordCount: doc.content.split(" ").length }),
      };
      const doc = createDoc("hello", "posts", {}, "one two three");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      expect(result.entries[0].transformed).toEqual({ wordCount: 3 });
    });

    it("passes document to transform", async () => {
      const transformFn = vi.fn().mockReturnValue({});
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: transformFn,
      };
      const doc = createDoc("hello", "posts", { title: "Test" }, "Content");
      doc.file.collection = collection;

      await transform([doc], createConfig([collection]));

      expect(transformFn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { title: "Test" },
          content: "Content",
        }),
        expect.any(Object) // context
      );
    });
  });

  describe("context.skip()", () => {
    it("excludes document when skip is called", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: (_: any, ctx: any) => ctx.skip(),
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      expect(result.entries).toHaveLength(0);
      expect(result.skipped).toContain("/path/to/hello.md");
    });
  });

  describe("context.documents()", () => {
    it("accesses earlier collections", async () => {
      const authors = {
        name: "authors",
        directory: "content/authors",
        schema: z.object({}),
      };
      const posts = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: (_: any, ctx: any) => {
          const allAuthors = ctx.documents(authors);
          return { authorCount: allAuthors.length };
        },
      };

      const authorDoc = createDoc("john", "authors", { name: "John" });
      authorDoc.file.collection = authors;

      const postDoc = createDoc("hello", "posts");
      postDoc.file.collection = posts;

      const result = await transform(
        [authorDoc, postDoc],
        createConfig([authors, posts])
      );

      const post = result.entries.find((e) => e.collection === "posts");
      expect(post?.transformed).toEqual({ authorCount: 1 });
    });

    it("throws for undefined collection", async () => {
      const posts = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: (_: any, ctx: any) => {
          ctx.documents({ name: "unknown" });
        },
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = posts;

      const result = await transform([doc], createConfig([posts]));

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain("unknown");
    });
  });

  describe("context.cache()", () => {
    it("memoizes expensive computations", async () => {
      let callCount = 0;
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: async (_: any, ctx: any) => {
          const value = await ctx.cache("expensive", () => {
            callCount++;
            return "computed";
          });
          return { value };
        },
      };

      const doc1 = createDoc("one", "posts");
      doc1.file.collection = collection;
      const doc2 = createDoc("two", "posts");
      doc2.file.collection = collection;

      await transform([doc1, doc2], createConfig([collection]));

      expect(callCount).toBe(1);
    });
  });

  describe("error handling", () => {
    it("collects errors in development mode", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => { throw new Error("Transform failed"); },
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const config = createConfig([collection]);
      config.mode = "development";

      const result = await transform([doc], config);

      expect(result.entries).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBeInstanceOf(TransformError);
    });

    it("throws in production mode", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => { throw new Error("Transform failed"); },
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const config = createConfig([collection]);
      config.mode = "production";

      await expect(transform([doc], config)).rejects.toThrow(TransformError);
    });
  });

  describe("collection ordering", () => {
    it("processes collections in config order", async () => {
      const order: string[] = [];

      const first = {
        name: "first",
        directory: "content/first",
        schema: z.object({}),
        transform: () => { order.push("first"); return {}; },
      };
      const second = {
        name: "second",
        directory: "content/second",
        schema: z.object({}),
        transform: () => { order.push("second"); return {}; },
      };

      const doc1 = createDoc("a", "first");
      doc1.file.collection = first;
      const doc2 = createDoc("b", "second");
      doc2.file.collection = second;

      await transform([doc2, doc1], createConfig([first, second]));

      expect(order).toEqual(["first", "second"]);
    });
  });
});
```

## Acceptance Criteria

- [ ] Entries are created with correct id, slug, collection
- [ ] Transform function is called with document and context
- [ ] context.skip() excludes document
- [ ] context.documents() accesses earlier collections
- [ ] context.cache() memoizes computations
- [ ] Errors are collected in development mode
- [ ] Errors throw in production mode
- [ ] Collections are processed in config order
- [ ] Concurrency is limited (p-limit)
- [ ] All tests pass

## Notes

- Add `p-limit` as a dependency
- Concurrency defaults to CPU cores - 1
- Collection order matters for context.documents()
