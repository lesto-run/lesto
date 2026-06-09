import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { createCacheManager } from "../../cache/manager";
import { CACHE_VERSION } from "../../cache/types";
import type { AnyCollection } from "../../types";

const createCollection = (overrides = {}): AnyCollection => ({
  name: "posts",
  directory: "content/posts",
  schema: z.object({ title: z.string() }),
  ...overrides,
});

describe("cache manager", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-cache-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("creates cache directories on init", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const cacheDir = path.join(tempDir, ".docks", "cache");
      const parseCacheDir = path.join(cacheDir, "parse");
      const transformCacheDir = path.join(cacheDir, "transform");

      await expect(stat(parseCacheDir)).resolves.toBeDefined();
      await expect(stat(transformCacheDir)).resolves.toBeDefined();
    });

    it("creates manifest file on init", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();
      await manager.flush();

      const manifestPath = path.join(tempDir, ".docks", "cache", "manifest.json");
      const content = await readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(content);

      expect(manifest.version).toBe(CACHE_VERSION);
      expect(manifest.coreVersion).toBeTruthy();
      expect(manifest.collections).toBeDefined();
      expect(manifest.collections.posts).toBeDefined();
    });

    it("creates noop manager when enabled: false", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()], {
        enabled: false,
      });

      expect(manager.isEnabled()).toBe(false);
      expect(manager.getParseCache("posts", "test.md", "hash")).toBeNull();
      expect(manager.getTransformCache("posts", "test", "hash")).toBeNull();

      const stats = manager.getStats();
      expect(stats.parseHits).toBe(0);
      expect(stats.parseMisses).toBe(0);
    });

    it("handles clearCache option", async () => {
      const cacheDir = path.join(tempDir, ".docks", "cache");
      await mkdir(cacheDir, { recursive: true });
      await writeFile(path.join(cacheDir, "old-file.txt"), "old data");

      const manager = await createCacheManager(tempDir, [createCollection()], {
        clearCache: true,
      });
      await manager.init();

      const exists = await stat(path.join(cacheDir, "old-file.txt")).catch(() => null);
      expect(exists).toBeNull();
    });

    it("uses custom cache directory", async () => {
      const customCacheDir = path.join(tempDir, "custom-cache");
      const manager = await createCacheManager(tempDir, [createCollection()], {
        cacheDir: customCacheDir,
      });
      await manager.init();

      await expect(stat(customCacheDir)).resolves.toBeDefined();
      await expect(stat(path.join(customCacheDir, "parse"))).resolves.toBeDefined();
    });

    it("invalidates cache when cache version changes", async () => {
      const cacheDir = path.join(tempDir, ".docks", "cache");
      await mkdir(path.join(cacheDir, "parse"), { recursive: true });
      await mkdir(path.join(cacheDir, "transform"), { recursive: true });

      const oldManifest = {
        version: 0,
        coreVersion: "0.1.0",
        lastUpdated: Date.now(),
        configHash: "old-hash",
        collections: {},
      };
      await writeFile(path.join(cacheDir, "manifest.json"), JSON.stringify(oldManifest));
      await writeFile(path.join(cacheDir, "parse", "posts.json"), "{}");

      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();
      await manager.flush();

      const content = await readFile(path.join(cacheDir, "manifest.json"), "utf-8");
      const manifest = JSON.parse(content);

      expect(manifest.version).toBe(CACHE_VERSION);

      const oldCacheExists = await stat(path.join(cacheDir, "parse", "posts.json"))
        .then(() => true)
        .catch(() => false);
      expect(oldCacheExists).toBe(false);
    });
  });

  describe("parse cache", () => {
    it("returns null for uncached file (miss)", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const result = manager.getParseCache("posts", "test.md", "content-hash");

      expect(result).toBeNull();

      const stats = manager.getStats();
      expect(stats.parseMisses).toBe(1);
      expect(stats.parseHits).toBe(0);
    });

    it("returns cached result when content hash matches (hit)", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const cachedResult = {
        contentHash: "hash123",
        data: { title: "Test" },
        content: "# Test",
        slug: "test",
        meta: {
          path: "test.md",
          fileName: "test.md",
          extension: ".md",
          directory: "",
          pathSegments: [],
          isIndex: false,
        },
      };

      manager.setParseCache("posts", "test.md", cachedResult);

      const result = manager.getParseCache("posts", "test.md", "hash123");

      expect(result).toEqual(cachedResult);

      const stats = manager.getStats();
      expect(stats.parseHits).toBe(1);
      expect(stats.parseMisses).toBe(0);
      expect(stats.timeSaved).toBe(5);
    });

    it("returns null when content hash differs (miss)", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const cachedResult = {
        contentHash: "old-hash",
        data: { title: "Test" },
        content: "# Test",
        slug: "test",
        meta: {
          path: "test.md",
          fileName: "test.md",
          extension: ".md",
          directory: "",
          pathSegments: [],
          isIndex: false,
        },
      };

      manager.setParseCache("posts", "test.md", cachedResult);

      const result = manager.getParseCache("posts", "test.md", "new-hash");

      expect(result).toBeNull();

      const stats = manager.getStats();
      expect(stats.parseMisses).toBe(1);
      expect(stats.parseHits).toBe(0);
    });

    it("setParseCache stores result", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const result = {
        contentHash: "hash456",
        data: { title: "New Post" },
        content: "# New Post",
        slug: "new-post",
        meta: {
          path: "new-post.md",
          fileName: "new-post.md",
          extension: ".md",
          directory: "",
          pathSegments: [],
          isIndex: false,
        },
      };

      manager.setParseCache("posts", "new-post.md", result);

      const retrieved = manager.getParseCache("posts", "new-post.md", "hash456");

      expect(retrieved).toEqual(result);
    });

    it("stats track hits and misses correctly", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const result = {
        contentHash: "hash",
        data: {},
        content: "",
        slug: "test",
        meta: {
          path: "",
          fileName: "",
          extension: "",
          directory: "",
          pathSegments: [],
          isIndex: false,
        },
      };

      manager.setParseCache("posts", "test.md", result);

      manager.getParseCache("posts", "test.md", "hash");
      manager.getParseCache("posts", "test.md", "hash");
      manager.getParseCache("posts", "missing.md", "hash");
      manager.getParseCache("posts", "missing2.md", "hash");

      const stats = manager.getStats();
      expect(stats.parseHits).toBe(2);
      expect(stats.parseMisses).toBe(2);
      expect(stats.timeSaved).toBe(10);
    });

    it("handles multiple files in same collection", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const result1 = {
        contentHash: "hash1",
        data: { title: "Post 1" },
        content: "# Post 1",
        slug: "post-1",
        meta: {
          path: "post-1.md",
          fileName: "post-1.md",
          extension: ".md",
          directory: "",
          pathSegments: [],
          isIndex: false,
        },
      };

      const result2 = {
        contentHash: "hash2",
        data: { title: "Post 2" },
        content: "# Post 2",
        slug: "post-2",
        meta: {
          path: "post-2.md",
          fileName: "post-2.md",
          extension: ".md",
          directory: "",
          pathSegments: [],
          isIndex: false,
        },
      };

      manager.setParseCache("posts", "post-1.md", result1);
      manager.setParseCache("posts", "post-2.md", result2);

      const retrieved1 = manager.getParseCache("posts", "post-1.md", "hash1");
      const retrieved2 = manager.getParseCache("posts", "post-2.md", "hash2");

      expect(retrieved1?.data.title).toBe("Post 1");
      expect(retrieved2?.data.title).toBe("Post 2");
    });

    it("handles multiple collections", async () => {
      const collections = [
        createCollection({ name: "posts" }),
        createCollection({ name: "pages", directory: "content/pages" }),
      ];
      const manager = await createCacheManager(tempDir, collections);
      await manager.init();

      const postsResult = {
        contentHash: "hash1",
        data: { title: "Post" },
        content: "# Post",
        slug: "post",
        meta: {
          path: "post.md",
          fileName: "post.md",
          extension: ".md",
          directory: "",
          pathSegments: [],
          isIndex: false,
        },
      };

      const pagesResult = {
        contentHash: "hash2",
        data: { title: "Page" },
        content: "# Page",
        slug: "page",
        meta: {
          path: "page.md",
          fileName: "page.md",
          extension: ".md",
          directory: "",
          pathSegments: [],
          isIndex: false,
        },
      };

      manager.setParseCache("posts", "post.md", postsResult);
      manager.setParseCache("pages", "page.md", pagesResult);

      const retrievedPost = manager.getParseCache("posts", "post.md", "hash1");
      const retrievedPage = manager.getParseCache("pages", "page.md", "hash2");

      expect(retrievedPost?.data.title).toBe("Post");
      expect(retrievedPage?.data.title).toBe("Page");
    });
  });

  describe("transform cache", () => {
    it("returns null for uncached entry", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const result = manager.getTransformCache("posts", "entry-1", "parse-hash");

      expect(result).toBeNull();

      const stats = manager.getStats();
      expect(stats.transformMisses).toBe(1);
      expect(stats.transformHits).toBe(0);
    });

    it("returns cached result when parse hash matches", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const cachedResult = {
        parseHash: "parse-hash-123",
        transformed: { title: "Transformed", extra: "data" },
        skipped: false,
      };

      manager.setTransformCache("posts", "entry-1", cachedResult);

      const result = manager.getTransformCache("posts", "entry-1", "parse-hash-123");

      expect(result).toEqual(cachedResult);

      const stats = manager.getStats();
      expect(stats.transformHits).toBe(1);
      expect(stats.transformMisses).toBe(0);
      expect(stats.timeSaved).toBe(10);
    });

    it("returns null when parse hash differs", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const cachedResult = {
        parseHash: "old-parse-hash",
        transformed: { title: "Transformed" },
        skipped: false,
      };

      manager.setTransformCache("posts", "entry-1", cachedResult);

      const result = manager.getTransformCache("posts", "entry-1", "new-parse-hash");

      expect(result).toBeNull();

      const stats = manager.getStats();
      expect(stats.transformMisses).toBe(1);
      expect(stats.transformHits).toBe(0);
    });

    it("setTransformCache stores result", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const result = {
        parseHash: "parse-hash-456",
        transformed: { title: "New Transform", count: 42 },
        skipped: false,
      };

      manager.setTransformCache("posts", "entry-2", result);

      const retrieved = manager.getTransformCache("posts", "entry-2", "parse-hash-456");

      expect(retrieved).toEqual(result);
    });

    it("handles skipped entries", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const skippedResult = {
        parseHash: "parse-hash",
        transformed: null,
        skipped: true,
      };

      manager.setTransformCache("posts", "entry-skipped", skippedResult);

      const retrieved = manager.getTransformCache("posts", "entry-skipped", "parse-hash");

      expect(retrieved).toEqual(skippedResult);
      expect(retrieved?.skipped).toBe(true);
      expect(retrieved?.transformed).toBeNull();
    });

    it("handles multiple entries in same collection", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const result1 = {
        parseHash: "hash1",
        transformed: { title: "Entry 1" },
        skipped: false,
      };

      const result2 = {
        parseHash: "hash2",
        transformed: { title: "Entry 2" },
        skipped: false,
      };

      manager.setTransformCache("posts", "entry-1", result1);
      manager.setTransformCache("posts", "entry-2", result2);

      const retrieved1 = manager.getTransformCache("posts", "entry-1", "hash1");
      const retrieved2 = manager.getTransformCache("posts", "entry-2", "hash2");

      expect(retrieved1?.transformed?.title).toBe("Entry 1");
      expect(retrieved2?.transformed?.title).toBe("Entry 2");
    });
  });
});
