import { describe, it, expect, vi } from "vitest";
import { nn } from "./test-utils";
import { transform } from "../transformer";
import type { ParsedDocument } from "../parser";
import type { ResolvedConfig } from "../config";
import type { Document, TransformContext, AnyCollection } from "../types";
import { TransformError, SerializationError } from "../types";
import { z } from "zod";

const createDoc = (
  slug: string,
  collectionName: string,
  data: Record<string, unknown> = {},
  content = "",
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
    file: { path: `${slug}.md`, fileName: slug, extension: "md", directory: ".", pathSegments: [], isIndex: false },
  },
  slug,
  isMDX: false,
});

const createConfig = (collections: AnyCollection[]): ResolvedConfig => ({
  configPath: null,
  cwd: "/project",
  collections,
  taxonomies: [],
  mode: "development",
});

describe("transformer", () => {
  describe("basic transformation", () => {
    it("creates flattened entries without transform (render disabled)", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        render: false as const,
      };
      const doc = createDoc("hello", "posts", { title: "Hello" });
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      expect(result.entries).toHaveLength(1);
      // New flattened structure
      expect(nn(result.entries[0]).id).toBe("posts/hello");
      expect(nn(result.entries[0]).collection).toBe("posts");
      expect(nn(result.entries[0]).title).toBe("Hello"); // Data is flattened
      expect(nn(result.entries[0]).slug).toBe("hello");
      expect(nn(result.entries[0]).content).toBe("");
      expect(nn(result.entries[0]).rendered).toBeUndefined(); // render: false
    });

    it("auto-renders markdown by default", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
      };
      // Use H2 since H1 is stripped by default (to prevent duplicate titles with frontmatter)
      const doc = createDoc("hello", "posts", { title: "Hello" }, "## Heading\n\nParagraph");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      expect(result.entries).toHaveLength(1);
      // New flattened structure - rendered is directly on entry
      expect(nn(result.entries[0]).rendered).toBeDefined();
      const rendered = nn(result.entries[0]).rendered as {
        html: string;
        headings: Array<{ depth: number; text: string; slug: string }>;
      };
      expect(rendered.html).toContain("<h2");
      expect(rendered.html).toContain("<p>Paragraph</p>");
    });

    it("passes render options to renderer", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        render: { headingLevels: [1, 2, 3] },
      };
      const doc = createDoc("hello", "posts", {}, "# H1\n## H2\n### H3\n#### H4");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      const rendered = result.entries[0]?.rendered as {
        headings: Array<{ depth: number }>;
      };
      // With headingLevels: [1, 2, 3], h4 should be excluded
      expect(rendered.headings).toHaveLength(3);
      expect(rendered.headings.map(h => h.depth)).toEqual([1, 2, 3]);
    });

    it("provides reading time and excerpt in render result", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
      };
      const doc = createDoc(
        "hello",
        "posts",
        {},
        "# Title\n\n" + "word ".repeat(300) + "\n\n## Section"
      );
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      const rendered = result.entries[0]?.rendered as {
        readingTime: { minutes: number; words: number };
        excerpt: string;
        headings: Array<{ text: string }>;
      };
      expect(rendered.readingTime.words).toBeGreaterThan(300);
      expect(rendered.readingTime.minutes).toBeGreaterThan(0);
      expect(rendered.excerpt).toBeTruthy();
      expect(rendered.headings.find(h => h.text === "Section")).toBeDefined();
    });

    it("transform function overrides auto-rendering", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => ({ custom: "value" }),
      };
      const doc = createDoc("hello", "posts", {}, "# Heading\n\nParagraph");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      // Entry should contain transform result (flattened)
      expect(result.entries[0]?.custom).toBe("value");
      // No rendered field since transform was used
      expect(result.entries[0]?.rendered).toBeUndefined();
    });

    it("handles empty content gracefully", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
      };
      const doc = createDoc("empty", "posts", {}, "");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      const rendered = result.entries[0]?.rendered as {
        html: string;
        headings: unknown[];
        readingTime: { minutes: number; words: number };
        excerpt: string;
      };
      expect(rendered.html).toBe("");
      expect(rendered.headings).toEqual([]);
      expect(rendered.readingTime).toEqual({ minutes: 0, words: 0, text: "0 min read" });
      expect(rendered.excerpt).toBe("");
    });

    it("applies transform function and flattens result", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: (doc: Document) => ({ wordCount: doc.content.split(" ").length }),
      };
      const doc = createDoc("hello", "posts", {}, "one two three");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      // Transform result is flattened onto entry
      expect(nn(result.entries[0]).wordCount).toBe(3);
      expect(nn(result.entries[0]).id).toBe("posts/hello");
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
        expect.any(Object), // context
      );
    });
  });

  describe("context.skip()", () => {
    it("excludes document when skip is called", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: (_: Document, ctx: TransformContext) => ctx.skip(),
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
        render: false as const,
      };
      const posts = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: (_: Document, ctx: TransformContext) => {
          const allAuthors = ctx.documents(authors);
          return { authorCount: allAuthors.length };
        },
      };

      const authorDoc = createDoc("john", "authors", { name: "John" });
      authorDoc.file.collection = authors;

      const postDoc = createDoc("hello", "posts");
      postDoc.file.collection = posts;

      const result = await transform([authorDoc, postDoc], createConfig([authors, posts]));

      const post = result.entries.find((e) => e.collection === "posts");
      // Transform result is flattened
      expect(post?.authorCount).toBe(1);
    });

    it("throws for undefined collection", async () => {
      const posts: AnyCollection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: (_: Document, ctx: TransformContext): Record<string, unknown> => {
          ctx.documents({ name: "unknown" } as AnyCollection);
          return {};
        },
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = posts;

      const result = await transform([doc], createConfig([posts]));

      expect(result.errors).toHaveLength(1);
      expect(nn(result.errors[0]).message).toContain("unknown");
    });
  });

  describe("context.cache()", () => {
    it("memoizes expensive computations", async () => {
      let callCount = 0;
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: async (_: Document, ctx: TransformContext) => {
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

    it("handles async factory that throws", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: async (_: Document, ctx: TransformContext) => {
          const value = await ctx.cache("failing", async () => {
            throw new Error("Factory failed");
          });
          return { value };
        },
      };

      const doc = createDoc("one", "posts");
      doc.file.collection = collection;

      const config = createConfig([collection]);
      config.mode = "development";

      const result = await transform([doc], config);

      expect(result.errors).toHaveLength(1);
      expect(nn(result.errors[0]).message).toContain("Factory failed");
    });
  });

  describe("error handling", () => {
    it("collects errors in development mode", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => {
          throw new Error("Transform failed");
        },
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
        transform: () => {
          throw new Error("Transform failed");
        },
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
        transform: () => {
          order.push("first");
          return {};
        },
      };
      const second = {
        name: "second",
        directory: "content/second",
        schema: z.object({}),
        transform: () => {
          order.push("second");
          return {};
        },
      };

      const doc1 = createDoc("a", "first");
      doc1.file.collection = first;
      const doc2 = createDoc("b", "second");
      doc2.file.collection = second;

      await transform([doc2, doc1], createConfig([first, second]));

      expect(order).toEqual(["first", "second"]);
    });
  });

  describe("serialization validation", () => {
    it("detects functions in transform output", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => ({
          handler: () => {},
        }),
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      expect(result.serializationErrors).toHaveLength(1);
      expect(result.serializationErrors[0]).toBeInstanceOf(SerializationError);
      expect(nn(nn(result.serializationErrors[0]).issues[0]).type).toBe("function");
    });

    it("detects symbols in transform output", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => ({
          key: Symbol("test"),
        }),
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      expect(result.serializationErrors).toHaveLength(1);
      expect(nn(nn(result.serializationErrors[0]).issues[0]).type).toBe("symbol");
    });

    it("detects bigint in transform output", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => ({
          bigValue: BigInt(123),
        }),
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      expect(result.serializationErrors).toHaveLength(1);
      expect(nn(nn(result.serializationErrors[0]).issues[0]).type).toBe("bigint");
    });

    it("detects circular references in transform output", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => {
          const obj: Record<string, unknown> = { name: "test" };
          obj.self = obj;
          return obj;
        },
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      expect(result.serializationErrors).toHaveLength(1);
      expect(nn(nn(result.serializationErrors[0]).issues[0]).type).toBe("circular");
    });

    it("skips validation when validateSerialization is false", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        validateSerialization: false,
        transform: () => ({
          handler: () => {},
        }),
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      expect(result.serializationErrors).toHaveLength(0);
      expect(result.entries).toHaveLength(1);
    });

    it("throws in production mode for critical issues", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => ({
          handler: () => {},
        }),
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const config = createConfig([collection]);
      config.mode = "production";

      await expect(transform([doc], config)).rejects.toThrow(SerializationError);
    });

    it("collects serialization errors in development mode", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => ({
          handler: () => {},
        }),
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const config = createConfig([collection]);
      config.mode = "development";

      const result = await transform([doc], config);

      expect(result.serializationErrors).toHaveLength(1);
      expect(result.entries).toHaveLength(1);
    });

    it("does not treat undefined as critical issue", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => ({
          value: undefined,
        }),
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const config = createConfig([collection]);
      config.mode = "production";

      const result = await transform([doc], config);

      expect(result.serializationErrors).toHaveLength(0);
      expect(result.entries).toHaveLength(1);
    });

    it("validates nested objects", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => ({
          nested: {
            deep: {
              handler: () => {},
            },
          },
        }),
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      expect(result.serializationErrors).toHaveLength(1);
      expect(nn(nn(result.serializationErrors[0]).issues[0]).path).toContain("nested.deep.handler");
    });

    it("validates arrays", async () => {
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({}),
        transform: () => ({
          items: [1, 2, () => {}],
        }),
      };
      const doc = createDoc("hello", "posts");
      doc.file.collection = collection;

      const result = await transform([doc], createConfig([collection]));

      expect(result.serializationErrors).toHaveLength(1);
      expect(nn(nn(result.serializationErrors[0]).issues[0]).path).toContain("[2]");
    });
  });
});
