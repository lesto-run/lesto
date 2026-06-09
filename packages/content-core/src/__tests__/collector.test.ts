import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collect, collectOne } from "../collector";
import { z } from "zod";
import { createTestCollection, nn } from "./test-utils";

const createCollection = (overrides = {}) => ({
  name: "posts",
  directory: "content/posts",
  schema: z.object({ title: z.string() }),
  ...overrides,
});

const collectorCustomParser = (content: string) => ({
  data: { title: "Custom" },
  content: content,
});

describe("collector", () => {
  let tempDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-test-"));
    contentDir = path.join(tempDir, "content", "posts");
    await mkdir(contentDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("collect", () => {
    it("finds markdown files", async () => {
      await writeFile(path.join(contentDir, "post1.md"), "# Post 1");
      await writeFile(path.join(contentDir, "post2.md"), "# Post 2");

      const config = {
        cwd: tempDir,
        collections: [createCollection()],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.relativePath).toSorted()).toEqual(["post1.md", "post2.md"]);
    });

    it("respects include patterns", async () => {
      await writeFile(path.join(contentDir, "post.md"), "# Post");
      await writeFile(path.join(contentDir, "post.mdx"), "# MDX Post");

      const config = {
        cwd: tempDir,
        collections: [createCollection({ include: "**/*.mdx" })],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(files).toHaveLength(1);
      expect(nn(files[0]).relativePath).toBe("post.mdx");
    });

    it("respects exclude patterns", async () => {
      await writeFile(path.join(contentDir, "post.md"), "# Post");
      await mkdir(path.join(contentDir, "drafts"));
      await writeFile(path.join(contentDir, "drafts", "draft.md"), "# Draft");

      const config = {
        cwd: tempDir,
        collections: [createCollection({ exclude: "**/drafts/**" })],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(files).toHaveLength(1);
      expect(nn(files[0]).relativePath).toBe("post.md");
    });

    it("handles nested directories", async () => {
      await mkdir(path.join(contentDir, "2024"));
      await writeFile(path.join(contentDir, "2024", "nested.md"), "# Nested");

      const config = {
        cwd: tempDir,
        collections: [createCollection()],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(files).toHaveLength(1);
      expect(nn(files[0]).relativePath).toBe(path.join("2024", "nested.md"));
    });

    it("handles missing directory gracefully", async () => {
      const config = {
        cwd: tempDir,
        collections: [createCollection({ directory: "content/missing" })],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(files).toHaveLength(0);
    });

    it("collects from multiple collections", async () => {
      const pagesDir = path.join(tempDir, "content", "pages");
      await mkdir(pagesDir, { recursive: true });
      await writeFile(path.join(contentDir, "post.md"), "# Post");
      await writeFile(path.join(pagesDir, "about.md"), "# About");

      const config = {
        cwd: tempDir,
        collections: [
          createCollection(),
          createCollection({ name: "pages", directory: "content/pages" }),
        ],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(files).toHaveLength(2);
      expect(files.find((f) => f.collection.name === "posts")).toBeTruthy();
      expect(files.find((f) => f.collection.name === "pages")).toBeTruthy();
    });

    it("ignores node_modules", async () => {
      const nmDir = path.join(contentDir, "node_modules");
      await mkdir(nmDir, { recursive: true });
      await writeFile(path.join(nmDir, "ignored.md"), "# Ignored");
      await writeFile(path.join(contentDir, "post.md"), "# Post");

      const config = {
        cwd: tempDir,
        collections: [createCollection()],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(files).toHaveLength(1);
      expect(nn(files[0]).relativePath).toBe("post.md");
    });

    it("attaches collection reference to files", async () => {
      await writeFile(path.join(contentDir, "post.md"), "# Post");

      const collection = createCollection();
      const config = {
        cwd: tempDir,
        collections: [collection],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(nn(files[0]).collection).toBe(collection);
    });
  });

  describe("collectOne", () => {
    it("collects for a single collection", async () => {
      await writeFile(path.join(contentDir, "post.md"), "# Post");

      const files = await collectOne(createTestCollection(), tempDir);

      expect(files).toHaveLength(1);
    });
  });

  describe("parser-based include patterns", () => {
    it("uses parser extensions when no include specified", async () => {
      await writeFile(path.join(contentDir, "data1.json"), '{"title": "JSON 1"}');
      await writeFile(path.join(contentDir, "data2.json"), '{"title": "JSON 2"}');
      await writeFile(path.join(contentDir, "post.md"), "# Markdown Post");

      const config = {
        cwd: tempDir,
        collections: [createCollection({ parser: "json" })],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.relativePath).toSorted()).toEqual(["data1.json", "data2.json"]);
    });

    it("uses explicit include over parser defaults", async () => {
      await writeFile(path.join(contentDir, "config.json"), '{"title": "Config"}');
      await writeFile(path.join(contentDir, "items.data.json"), '{"title": "Data"}');

      const config = {
        cwd: tempDir,
        collections: [
          createCollection({
            parser: "json",
            include: "**/*.data.json",
          }),
        ],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(files).toHaveLength(1);
      expect(nn(files[0]).relativePath).toBe("items.data.json");
    });

    it("falls back to **/*.md for custom parser without extensions", async () => {
      await writeFile(path.join(contentDir, "post.md"), "# Markdown Post");
      await writeFile(path.join(contentDir, "data.json"), '{"title": "JSON"}');

      const config = {
        cwd: tempDir,
        collections: [createCollection({ parser: collectorCustomParser })],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(files).toHaveLength(1);
      expect(nn(files[0]).relativePath).toBe("post.md");
    });
  });

  describe("edge cases", () => {
    it("handles absolute directory paths", async () => {
      await writeFile(path.join(contentDir, "post.md"), "# Post");

      const config = {
        cwd: tempDir,
        collections: [createCollection({ directory: contentDir })],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(files).toHaveLength(1);
      expect(nn(files[0]).relativePath).toBe("post.md");
    });

    it("handles directory that is actually a file", async () => {
      const fakeDir = path.join(tempDir, "content", "fake-dir");
      await mkdir(path.dirname(fakeDir), { recursive: true });
      await writeFile(fakeDir, "This is a file, not a directory");

      const config = {
        cwd: tempDir,
        collections: [createCollection({ directory: "content/fake-dir" })],
        mode: "development" as const,
        configPath: null,
        taxonomies: [],
      };

      const files = await collect(config);

      expect(files).toHaveLength(0);
    });
  });
});
