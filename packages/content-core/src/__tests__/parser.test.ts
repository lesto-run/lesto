import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nn } from "./test-utils";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse } from "../parser";
import { ValidationError } from "../types";
import type { CollectionSchema } from "../types";
import type { CollectedFile } from "../collector";
import { z } from "zod";

const customParser = (content: string) => ({
  data: { custom: true, length: content.length },
  content: content.toUpperCase(),
});

const createCollectedFile = (
  absolutePath: string,
  relativePath: string,
  schema: CollectionSchema = z.object({ title: z.string() }),
): CollectedFile => ({
  absolutePath,
  relativePath,
  collection: {
    name: "posts",
    directory: "content/posts",
    schema,
  },
});

describe("parser", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const createFile = async (
    relativePath: string,
    frontmatter: Record<string, unknown>,
    content: string,
  ) => {
    const fullPath = path.join(tempDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });

    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");

    await writeFile(fullPath, `---\n${fm}\n---\n\n${content}`);
    return fullPath;
  };

  describe("parse", () => {
    it("parses frontmatter correctly", async () => {
      const filePath = await createFile("post.md", { title: "Hello" }, "Content");
      const file = createCollectedFile(filePath, "post.md");

      const { documents } = await parse([file]);

      expect(documents).toHaveLength(1);
      expect(nn(documents[0]).document.data).toEqual({ title: "Hello" });
    });

    it("extracts content without frontmatter", async () => {
      const filePath = await createFile("post.md", { title: "Hello" }, "Body content");
      const file = createCollectedFile(filePath, "post.md");

      const { documents } = await parse([file]);

      expect(nn(documents[0]).document.content.trim()).toBe("Body content");
    });

    it("validates against schema", async () => {
      const filePath = await createFile("post.md", { title: 123 }, "Content");
      const schema = z.object({ title: z.string() });
      const file = createCollectedFile(filePath, "post.md", schema);

      const { documents, errors } = await parse([file]);

      expect(documents).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(ValidationError);
    });

    it("coerces types via schema", async () => {
      const filePath = await createFile("post.md", { date: "2024-01-01" }, "Content");
      const schema = z.object({ date: z.coerce.date() });
      const file = createCollectedFile(filePath, "post.md", schema);

      const { documents } = await parse([file]);

      expect(nn(documents[0]).document.data.date).toBeInstanceOf(Date);
    });

    it("applies default values", async () => {
      const filePath = await createFile("post.md", { title: "Hello" }, "Content");
      const schema = z.object({
        title: z.string(),
        draft: z.boolean().default(false),
      });
      const file = createCollectedFile(filePath, "post.md", schema);

      const { documents } = await parse([file]);

      expect(nn(documents[0]).document.data.draft).toBe(false);
    });

    it("builds correct document meta", async () => {
      const filePath = await createFile("post.md", { title: "Hello" }, "Content");
      const file = createCollectedFile(filePath, "post.md");

      const { documents } = await parse([file]);

      expect(nn(documents[0]).document.file).toEqual({
        path: "post.md",
        fileName: "post",
        extension: "md",
        directory: ".",
        pathSegments: ["post"],
        isIndex: false,
      });
    });

    it("handles nested file paths", async () => {
      const filePath = await createFile(
        path.join("2024", "01", "post.md"),
        { title: "Hello" },
        "Content",
      );
      const file = createCollectedFile(filePath, path.join("2024", "01", "post.md"));

      const { documents } = await parse([file]);

      expect(nn(documents[0]).document.file.directory).toBe(path.join("2024", "01"));
      expect(nn(documents[0]).slug).toBe("2024/01/post");
    });
  });

  describe("slug derivation", () => {
    it("uses filename as slug", async () => {
      const filePath = await createFile("my-post.md", { title: "Hello" }, "");
      const file = createCollectedFile(filePath, "my-post.md");

      const { documents } = await parse([file]);

      expect(nn(documents[0]).slug).toBe("my-post");
    });

    it("uses parent directory for index.md", async () => {
      const filePath = await createFile("about/index.md", { title: "About" }, "");
      const file = createCollectedFile(filePath, path.join("about", "index.md"));

      const { documents } = await parse([file]);

      expect(nn(documents[0]).slug).toBe("about");
    });

    it("handles root index.md", async () => {
      const filePath = await createFile("index.md", { title: "Home" }, "");
      const file = createCollectedFile(filePath, "index.md");

      const { documents } = await parse([file]);

      expect(nn(documents[0]).slug).toBe("index");
    });
  });

  describe("pathSegments and isIndex", () => {
    it("sets pathSegments for regular files", async () => {
      const filePath = await createFile("my-post.md", { title: "Hello" }, "");
      const file = createCollectedFile(filePath, "my-post.md");

      const { documents } = await parse([file]);

      expect(nn(documents[0]).document.file.pathSegments).toEqual(["my-post"]);
      expect(nn(documents[0]).document.file.isIndex).toBe(false);
    });

    it("sets pathSegments for nested files", async () => {
      const filePath = await createFile(
        path.join("getting-started", "introduction.md"),
        { title: "Introduction" },
        "",
      );
      const file = createCollectedFile(filePath, path.join("getting-started", "introduction.md"));

      const { documents } = await parse([file]);

      expect(nn(documents[0]).document.file.pathSegments).toEqual(["getting-started", "introduction"]);
      expect(nn(documents[0]).document.file.isIndex).toBe(false);
    });

    it("sets isIndex true for index.md", async () => {
      const filePath = await createFile("about/index.md", { title: "About" }, "");
      const file = createCollectedFile(filePath, path.join("about", "index.md"));

      const { documents } = await parse([file]);

      expect(nn(documents[0]).document.file.pathSegments).toEqual(["about"]);
      expect(nn(documents[0]).document.file.isIndex).toBe(true);
    });

    it("sets isIndex true for README.md", async () => {
      const filePath = await createFile("docs/README.md", { title: "Docs" }, "");
      const file = createCollectedFile(filePath, path.join("docs", "README.md"));

      const { documents } = await parse([file]);

      expect(nn(documents[0]).document.file.pathSegments).toEqual(["docs"]);
      expect(nn(documents[0]).document.file.isIndex).toBe(true);
    });

    it("handles root index.md pathSegments", async () => {
      const filePath = await createFile("index.md", { title: "Home" }, "");
      const file = createCollectedFile(filePath, "index.md");

      const { documents } = await parse([file]);

      expect(nn(documents[0]).document.file.pathSegments).toEqual([]);
      expect(nn(documents[0]).document.file.isIndex).toBe(true);
    });

    it("handles deeply nested paths", async () => {
      const filePath = await createFile(
        path.join("api", "reference", "get-collection.md"),
        { title: "getCollection" },
        "",
      );
      const file = createCollectedFile(filePath, path.join("api", "reference", "get-collection.md"));

      const { documents } = await parse([file]);

      expect(nn(documents[0]).document.file.pathSegments).toEqual(["api", "reference", "get-collection"]);
      expect(nn(documents[0]).document.file.isIndex).toBe(false);
    });
  });

  describe("error handling", () => {
    it("returns validation errors without throwing", async () => {
      const file1 = await createFile("valid.md", { title: "Valid" }, "");
      const file2 = await createFile("invalid.md", { title: 123 }, "");

      const files = [
        createCollectedFile(file1, "valid.md"),
        createCollectedFile(file2, "invalid.md"),
      ];

      const { documents, errors } = await parse(files);

      expect(documents).toHaveLength(1);
      expect(errors).toHaveLength(1);
    });

    it("validation error includes file path", async () => {
      const filePath = await createFile("invalid.md", { title: 123 }, "");
      const file = createCollectedFile(filePath, "invalid.md");

      const { errors } = await parse([file]);

      expect(nn(errors[0]).filePath).toBe(filePath);
      expect(nn(errors[0]).collection).toBe("posts");
    });

    it("validation error includes field path", async () => {
      const filePath = await createFile("invalid.md", { title: 123 }, "");
      const file = createCollectedFile(filePath, "invalid.md");

      const { errors } = await parse([file]);

      expect(nn(nn(errors[0]).issues[0]).path).toContain("title");
    });
  });

  describe("multi-parser support", () => {
    it("uses json parser for collection with parser: 'json'", async () => {
      const jsonContent = JSON.stringify({ title: "JSON Post", author: "Alice" });
      const fullPath = path.join(tempDir, "post.json");
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, jsonContent);

      const file = {
        absolutePath: fullPath,
        relativePath: "post.json",
        collection: {
          name: "posts",
          directory: "content/posts",
          parser: "json" as const,
          schema: z.object({ title: z.string(), author: z.string() }),
        },
      };

      const { documents } = await parse([file]);

      expect(documents).toHaveLength(1);
      expect(nn(documents[0]).document.data).toEqual({
        title: "JSON Post",
        author: "Alice",
      });
      expect(nn(documents[0]).document.content).toBe("");
    });

    it("uses yaml parser for collection with parser: 'yaml'", async () => {
      const yamlContent = `title: YAML Post\nauthor: Bob\ntags:\n  - yaml\n  - test`;
      const fullPath = path.join(tempDir, "post.yaml");
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, yamlContent);

      const file = {
        absolutePath: fullPath,
        relativePath: "post.yaml",
        collection: {
          name: "posts",
          directory: "content/posts",
          parser: "yaml" as const,
          schema: z.object({
            title: z.string(),
            author: z.string(),
            tags: z.array(z.string()),
          }),
        },
      };

      const { documents } = await parse([file]);

      expect(documents).toHaveLength(1);
      expect(nn(documents[0]).document.data).toEqual({
        title: "YAML Post",
        author: "Bob",
        tags: ["yaml", "test"],
      });
      expect(nn(documents[0]).document.content).toBe("");
    });

    it("uses custom parser function", async () => {
      const fullPath = path.join(tempDir, "custom.txt");
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, "hello world");

      const file = {
        absolutePath: fullPath,
        relativePath: "custom.txt",
        collection: {
          name: "posts",
          directory: "content/posts",
          parser: customParser,
          schema: z.object({ custom: z.boolean(), length: z.number() }),
        },
      };

      const { documents } = await parse([file]);

      expect(documents).toHaveLength(1);
      expect(nn(documents[0]).document.data).toEqual({
        custom: true,
        length: 11,
      });
      expect(nn(documents[0]).document.content).toBe("HELLO WORLD");
    });

    it("uses frontmatter-only parser", async () => {
      const fullPath = path.join(tempDir, "post.md");
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, "---\ntitle: Frontmatter Only\n---\n\nThis content is ignored");

      const file = {
        absolutePath: fullPath,
        relativePath: "post.md",
        collection: {
          name: "posts",
          directory: "content/posts",
          parser: "frontmatter-only" as const,
          schema: z.object({ title: z.string() }),
        },
      };

      const { documents } = await parse([file]);

      expect(documents).toHaveLength(1);
      expect(nn(documents[0]).document.data.title).toBe("Frontmatter Only");
      expect(nn(documents[0]).document.content).toBe("");
    });
  });

  describe("cache integration", () => {
    it("uses cached parse result when content unchanged", async () => {
      const { createCacheManager } = await import("../cache");
      const filePath = await createFile("post.md", { title: "Cached" }, "Content");
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({ title: z.string() }),
      };
      const file = createCollectedFile(filePath, "post.md");

      const cache = await createCacheManager(tempDir, [collection]);
      await cache.init();

      const { documents: docs1 } = await parse([file], cache);
      expect(docs1).toHaveLength(1);

      const stats1 = cache.getStats();
      expect(stats1.parseMisses).toBe(1);
      expect(stats1.parseHits).toBe(0);

      const { documents: docs2 } = await parse([file], cache);
      expect(docs2).toHaveLength(1);
      expect(nn(docs2[0]).document.data).toEqual(nn(docs1[0]).document.data);

      const stats2 = cache.getStats();
      expect(stats2.parseHits).toBe(1);
      expect(stats2.parseMisses).toBe(1);

      await cache.flush();
    });

    it("invalidates cache when content changes", async () => {
      const { createCacheManager } = await import("../cache");
      const filePath = path.join(tempDir, "post.md");
      const collection = {
        name: "posts",
        directory: "content/posts",
        schema: z.object({ title: z.string() }),
      };

      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "---\ntitle: Original\n---\n\nContent");

      const file = {
        absolutePath: filePath,
        relativePath: "post.md",
        collection,
      };

      const cache = await createCacheManager(tempDir, [collection]);
      await cache.init();

      const { documents: docs1 } = await parse([file], cache);
      expect(nn(docs1[0]).document.data.title).toBe("Original");

      await writeFile(filePath, "---\ntitle: Modified\n---\n\nNew content");

      const { documents: docs2 } = await parse([file], cache);
      expect(nn(docs2[0]).document.data.title).toBe("Modified");

      const stats = cache.getStats();
      expect(stats.parseMisses).toBe(2);

      await cache.flush();
    });

    it("works with cache disabled", async () => {
      const filePath = await createFile("post.md", { title: "No Cache" }, "Content");
      const file = createCollectedFile(filePath, "post.md");

      const { documents } = await parse([file]);

      expect(documents).toHaveLength(1);
      expect(nn(documents[0]).document.data.title).toBe("No Cache");
    });

    it("caches results with different parsers", async () => {
      const { createCacheManager } = await import("../cache");

      const jsonPath = path.join(tempDir, "data.json");
      await writeFile(jsonPath, JSON.stringify({ title: "JSON Data" }));

      const yamlPath = path.join(tempDir, "data.yaml");
      await writeFile(yamlPath, "title: YAML Data");

      const collections = [
        {
          name: "json-collection",
          directory: "content/json",
          parser: "json" as const,
          schema: z.object({ title: z.string() }),
        },
        {
          name: "yaml-collection",
          directory: "content/yaml",
          parser: "yaml" as const,
          schema: z.object({ title: z.string() }),
        },
      ];

      const cache = await createCacheManager(tempDir, collections);
      await cache.init();

      const [jsonCollection, yamlCollection] = collections;
      if (!jsonCollection || !yamlCollection) throw new Error("collections missing");

      const files = [
        {
          absolutePath: jsonPath,
          relativePath: "data.json",
          collection: jsonCollection,
        },
        {
          absolutePath: yamlPath,
          relativePath: "data.yaml",
          collection: yamlCollection,
        },
      ];

      const { documents: docs1 } = await parse(files, cache);
      expect(docs1).toHaveLength(2);

      const { documents: docs2 } = await parse(files, cache);
      expect(docs2).toHaveLength(2);

      const stats = cache.getStats();
      expect(stats.parseHits).toBe(2);
      expect(stats.parseMisses).toBe(2);

      await cache.flush();
    });
  });
});
