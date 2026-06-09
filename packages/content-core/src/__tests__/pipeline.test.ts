import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nn } from "./test-utils";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runPipeline, pipeline } from "../pipeline";
import type { ValidationError, SerializationError, SerializationIssueInfo } from "../types";
import { z } from "zod";

describe("pipeline", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const setupProject = async (
    files: Array<{ path: string; frontmatter: Record<string, unknown>; content: string }>,
  ) => {
    for (const file of files) {
      const fullPath = path.join(tempDir, file.path);
      await mkdir(path.dirname(fullPath), { recursive: true });
      const fm = Object.entries(file.frontmatter)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n");
      await writeFile(fullPath, `---\n${fm}\n---\n\n${file.content}`);
    }
  };

  describe("runPipeline", () => {
    it("runs full pipeline with programmatic config", async () => {
      await setupProject([
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "World" },
      ]);

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "posts",
              directory: "content/posts",
              schema: z.object({ title: z.string() }),
            },
          ],
        },
        skipWrite: true,
      });

      expect(result.entries).toHaveLength(1);
      expect(nn(result.entries[0]).slug).toBe("hello");
      expect(nn(result.entries[0]).title).toBe("Hello");
    });

    it("collects files from multiple collections", async () => {
      await setupProject([
        { path: "content/posts/post.md", frontmatter: { title: "Post" }, content: "" },
        { path: "content/pages/page.md", frontmatter: { title: "Page" }, content: "" },
      ]);

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            { name: "posts", directory: "content/posts", schema: z.object({ title: z.string() }) },
            { name: "pages", directory: "content/pages", schema: z.object({ title: z.string() }) },
          ],
        },
        skipWrite: true,
      });

      expect(result.entries).toHaveLength(2);
      expect(result.files).toHaveLength(2);
    });

    it("applies transforms", async () => {
      await setupProject([
        {
          path: "content/posts/hello.md",
          frontmatter: { title: "Hello" },
          content: "one two three",
        },
      ]);

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "posts",
              directory: "content/posts",
              schema: z.object({ title: z.string() }),
              transform: (doc) => ({ wordCount: doc.content.trim().split(/\s+/).length }),
            },
          ],
        },
        skipWrite: true,
      });

      expect(nn(result.entries[0]).wordCount).toBe(3);
    });

    it("writes types file", async () => {
      await setupProject([
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "" },
      ]);

      const outDir = path.join(tempDir, ".docks");
      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "posts",
              directory: "content/posts",
              schema: z.object({ title: z.string() }),
            },
          ],
        },
        outDir,
      });

      expect(result.writeResult.typesPath).toContain("types.d.ts");

      const content = await readFile(result.writeResult.typesPath, "utf-8");
      expect(content).toContain("CollectionRegistry");
      expect(content).toContain('"posts"');
    });

    it("collects validation errors", async () => {
      await setupProject([
        { path: "content/posts/valid.md", frontmatter: { title: "Valid" }, content: "" },
        { path: "content/posts/invalid.md", frontmatter: { title: 123 }, content: "" },
      ]);

      const warnings: ValidationError[] = [];
      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "posts",
              directory: "content/posts",
              schema: z.object({ title: z.string() }),
            },
          ],
          onValidationWarning: (err) => warnings.push(err),
        },
        skipWrite: true,
      });

      expect(result.entries).toHaveLength(1);
      expect(warnings).toHaveLength(1);
    });

    it("reports skipped documents", async () => {
      await setupProject([
        { path: "content/posts/skip.md", frontmatter: { title: "Skip" }, content: "" },
      ]);

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "posts",
              directory: "content/posts",
              schema: z.object({ title: z.string() }),
              transform: (_document, ctx) => ctx.skip(),
            },
          ],
        },
        skipWrite: true,
      });

      expect(result.entries).toHaveLength(0);
      expect(result.transformResult.skipped).toHaveLength(1);
    });
  });

  describe("cache integration", () => {
    it("returns cache stats in result", async () => {
      await setupProject([
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "World" },
      ]);

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "posts",
              directory: "content/posts",
              schema: z.object({ title: z.string() }),
            },
          ],
        },
        skipWrite: true,
      });

      expect(result.cacheStats).toBeDefined();
      expect(result.cacheStats).toHaveProperty("parseHits");
      expect(result.cacheStats).toHaveProperty("parseMisses");
      expect(result.cacheStats).toHaveProperty("transformHits");
      expect(result.cacheStats).toHaveProperty("transformMisses");
      expect(result.cacheStats).toHaveProperty("timeSaved");
    });

    it("accepts cache options", async () => {
      await setupProject([
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "World" },
      ]);

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "posts",
              directory: "content/posts",
              schema: z.object({ title: z.string() }),
            },
          ],
        },
        cache: { enabled: false },
        skipWrite: true,
      });

      expect(result.entries).toHaveLength(1);
      expect(result.cacheStats).toBeDefined();
    });
  });

  describe("serialization warnings", () => {
    it("calls onSerializationWarning for issues", async () => {
      await setupProject([
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "World" },
      ]);

      const warnings: SerializationError[] = [];
      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "posts",
              directory: "content/posts",
              schema: z.object({ title: z.string() }),
              transform: () => ({ func: () => "not serializable" }),
            },
          ],
          onSerializationWarning: (err) => warnings.push(err),
        },
        skipWrite: true,
      });

      expect(result.entries).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(nn(warnings[0]).entryId).toBe("posts/hello");
      expect(nn(warnings[0]).issues).toBeDefined();
      expect(nn(warnings[0]).issues.some((i: SerializationIssueInfo) => i.type === "function")).toBe(true);
    });

    it("falls back to console.warn if no callback provided", async () => {
      await setupProject([
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "World" },
      ]);

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "posts",
              directory: "content/posts",
              schema: z.object({ title: z.string() }),
              transform: () => ({ func: () => "not serializable" }),
            },
          ],
        },
        skipWrite: true,
      });

      expect(result.entries).toHaveLength(1);
      expect(result.transformResult.serializationErrors).toHaveLength(1);
    });
  });

  describe("pipeline exports", () => {
    it("exports individual stages", () => {
      expect(typeof pipeline.config).toBe("function");
      expect(typeof pipeline.collect).toBe("function");
      expect(typeof pipeline.parse).toBe("function");
      expect(typeof pipeline.transform).toBe("function");
      expect(typeof pipeline.write).toBe("function");
      expect(typeof pipeline.run).toBe("function");
    });
  });
});
