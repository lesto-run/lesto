import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { createContextStore, createTransformContext, SkipDocumentError } from "../context";
import type { AnyCollection, RuntimeEntry } from "../types";

/** Minimal collection stub for exercising `ctx.documents()`, which only reads `name`. */
function collectionStub(name: string): AnyCollection {
  return { name, directory: `content/${name}`, schema: z.object({}) };
}

/** Build a runtime entry with the metadata fields `documents()` may carry. */
function entryStub(
  id: string,
  collection: string,
  extra: Record<string, unknown>,
): RuntimeEntry {
  const [, ...rest] = id.split("/");
  const slug = rest.join("/") || id;
  return {
    id,
    collection,
    file: {
      path: `${collection}/${slug}.md`,
      fileName: `${slug}.md`,
      extension: ".md",
      directory: collection,
      pathSegments: [slug],
      isIndex: false,
    },
    slug,
    ...extra,
  };
}

describe("TransformContext", () => {
  let store: ReturnType<typeof createContextStore>;

  beforeEach(() => {
    store = createContextStore();
  });

  describe("documents()", () => {
    it("returns entries from earlier collections", () => {
      const entries = [
        entryStub("authors/john", "authors", { data: { name: "John" } }),
      ];
      store.collections.set("authors", entries);

      const ctx = createTransformContext("posts", "content/posts", "/path/to/file.md", store);
      const mockCollection = collectionStub("authors");

      const result = ctx.documents(mockCollection);
      expect(result).toBe(entries);
    });

    it("throws for undefined collections", () => {
      const ctx = createTransformContext("posts", "content/posts", "/path/to/file.md", store);
      const mockCollection = collectionStub("unknown");

      expect(() => ctx.documents(mockCollection)).toThrow('Collection "unknown" not found');
    });

    it("error message suggests ordering fix", () => {
      const ctx = createTransformContext("posts", "content/posts", "/path/to/file.md", store);
      const mockCollection = collectionStub("authors");

      expect(() => ctx.documents(mockCollection)).toThrow(
        'Ensure it appears before "posts" in your collections array',
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

      expect(await store.cache.get("posts:key")).toBe("posts-value");
      expect(await store.cache.get("pages:key")).toBe("pages-value");
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
