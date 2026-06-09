import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generate } from "../generator";
import { z } from "zod";

const createCollections = () => [
  {
    name: "posts",
    directory: "content/posts",
    include: "**/*.md",
    schema: z.object({
      title: z.string(),
      date: z.coerce.date(),
    }),
  },
];

describe("fast-json-stringify optimization", () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-fjs-test-"));
    originalEnv = process.env["NODE_ENV"];
  });

  afterEach(async () => {
    // Restore environment before cleanup to prevent leaking
    process.env["NODE_ENV"] = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  const setupProject = async (count: number) => {
    for (let i = 0; i < count; i++) {
      const fullPath = path.join(tempDir, `content/posts/post-${i}.md`);
      await mkdir(path.dirname(fullPath), { recursive: true });
      const frontmatter = `title: "Post ${i}"\ndate: "2024-01-${String(i + 1).padStart(2, "0")}"`;
      await writeFile(fullPath, `---\n${frontmatter}\n---\n\nContent for post ${i}`);
    }
  };

  describe("production mode", () => {
    beforeEach(() => {
      process.env["NODE_ENV"] = "production";
    });

    it("generates valid output", async () => {
      await setupProject(10);

      const result = await generate({
        cwd: tempDir,
        collections: createCollections(),
      });

      expect(result.collections).toEqual(["posts"]);
      expect(result.entryCount).toBe(10);

      const postsModule = await import(path.join(result.outDir, "posts.js"));
      const posts = postsModule.default;

      expect(posts).toHaveLength(10);
      expect(posts[0].title).toMatch(/^Post \d+$/);
      expect(posts[0].date).toBeInstanceOf(Date);
    });

    it("output is minified (no indentation)", async () => {
      await setupProject(5);

      const result = await generate({
        cwd: tempDir,
        collections: createCollections(),
      });

      const postsContent = await readFile(path.join(result.outDir, "posts.js"), "utf-8");

      const jsonStart = postsContent.indexOf("const data = [");
      const jsonEnd = postsContent.indexOf("];", jsonStart) + 2;
      const jsonSection = postsContent.substring(jsonStart, jsonEnd);
      const lineCount = jsonSection.split("\n").length;

      expect(lineCount).toBeLessThan(10);
    });
  });

  describe("development mode", () => {
    beforeEach(() => {
      process.env["NODE_ENV"] = "development";
    });

    it("generates valid output", async () => {
      await setupProject(10);

      const result = await generate({
        cwd: tempDir,
        collections: createCollections(),
      });

      expect(result.collections).toEqual(["posts"]);
      expect(result.entryCount).toBe(10);

      const postsModule = await import(path.join(result.outDir, "posts.js"));
      const posts = postsModule.default;

      expect(posts).toHaveLength(10);
      expect(posts[0].title).toMatch(/^Post \d+$/);
      expect(posts[0].date).toBeInstanceOf(Date);
    });

    it("output is pretty-printed (with indentation)", async () => {
      await setupProject(5);

      const result = await generate({
        cwd: tempDir,
        collections: createCollections(),
      });

      const postsContent = await readFile(path.join(result.outDir, "posts.js"), "utf-8");

      const jsonStart = postsContent.indexOf("const data = [");
      const jsonEnd = postsContent.indexOf("];", jsonStart) + 2;
      const jsonSection = postsContent.substring(jsonStart, jsonEnd);
      const lineCount = jsonSection.split("\n").length;

      expect(lineCount).toBeGreaterThan(30);
      expect(postsContent).toMatch(/\n {2}/);
    });
  });
});
