import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { createCacheManager } from "../../cache/manager";
import type { AnyCollection, Document } from "../../types";

const createCollection = (overrides = {}): AnyCollection => ({
  name: "posts",
  directory: "content/posts",
  schema: z.object({ title: z.string() }),
  ...overrides,
});

describe("cache persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-cache-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("flush", () => {
    it("writes to disk", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const parseResult = {
        contentHash: "hash",
        data: { title: "Test" },
        content: "# Test",
        slug: "test",
        meta: { path: "test.md", fileName: "test.md", extension: ".md", directory: "", pathSegments: [], isIndex: false },
      };

      const transformResult = {
        parseHash: "parse-hash",
        transformed: { title: "Transformed" },
        skipped: false,
      };

      manager.setParseCache("posts", "test.md", parseResult);
      manager.setTransformCache("posts", "test", transformResult);

      await manager.flush();

      const cacheDir = path.join(tempDir, ".docks", "cache");
      const parseCache = await readFile(path.join(cacheDir, "parse", "posts.json"), "utf-8");
      const transformCache = await readFile(
        path.join(cacheDir, "transform", "posts.json"),
        "utf-8",
      );

      const parseCacheData = JSON.parse(parseCache);
      const transformCacheData = JSON.parse(transformCache);

      expect(parseCacheData["test.md"]).toEqual(parseResult);
      expect(transformCacheData["test"]).toEqual(transformResult);
    });

    it("updates manifest", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const initialFlushTime = Date.now();
      await manager.flush();

      await new Promise((resolve) => setTimeout(resolve, 10));

      const parseResult = {
        contentHash: "hash",
        data: {},
        content: "",
        slug: "test",
        meta: { path: "", fileName: "", extension: "", directory: "", pathSegments: [], isIndex: false },
      };
      manager.setParseCache("posts", "test.md", parseResult);

      await manager.flush();

      const manifestPath = path.join(tempDir, ".docks", "cache", "manifest.json");
      const content = await readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(content);

      expect(manifest.lastUpdated).toBeGreaterThanOrEqual(initialFlushTime);
      expect(manifest.collections.posts.entryCount).toBe(1);
    });
  });

  describe("load", () => {
    it("loads cached data after restart", async () => {
      const collection = createCollection();

      let manager = await createCacheManager(tempDir, [collection]);
      await manager.init();

      const parseResult = {
        contentHash: "hash123",
        data: { title: "Persisted" },
        content: "# Persisted",
        slug: "persisted",
        meta: { path: "test.md", fileName: "test.md", extension: ".md", directory: "", pathSegments: [], isIndex: false },
      };

      manager.setParseCache("posts", "test.md", parseResult);
      await manager.flush();

      manager = await createCacheManager(tempDir, [collection]);
      await manager.init();

      const retrieved = manager.getParseCache("posts", "test.md", "hash123");

      expect(retrieved).toEqual(parseResult);
    });
  });

  describe("clear", () => {
    it("removes cache", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const parseResult = {
        contentHash: "hash",
        data: {},
        content: "",
        slug: "test",
        meta: { path: "", fileName: "", extension: "", directory: "", pathSegments: [], isIndex: false },
      };

      manager.setParseCache("posts", "test.md", parseResult);
      await manager.flush();

      await manager.clear();

      const cacheDir = path.join(tempDir, ".docks", "cache");
      const exists = await stat(cacheDir).catch(() => null);

      expect(exists).toBeNull();
      expect(manager.getParseCache("posts", "test.md", "hash")).toBeNull();
    });
  });

  describe("getStats", () => {
    it("returns statistics", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const stats1 = manager.getStats();
      expect(stats1).toEqual({
        parseHits: 0,
        parseMisses: 0,
        transformHits: 0,
        transformMisses: 0,
        timeSaved: 0,
      });

      const parseResult = {
        contentHash: "hash",
        data: {},
        content: "",
        slug: "test",
        meta: { path: "", fileName: "", extension: "", directory: "", pathSegments: [], isIndex: false },
      };

      manager.setParseCache("posts", "test.md", parseResult);
      manager.getParseCache("posts", "test.md", "hash");
      manager.getParseCache("posts", "missing.md", "hash");

      const stats2 = manager.getStats();
      expect(stats2.parseHits).toBe(1);
      expect(stats2.parseMisses).toBe(1);
      expect(stats2.timeSaved).toBe(5);
    });
  });

  describe("isEnabled", () => {
    it("returns correct value", async () => {
      const enabledManager = await createCacheManager(tempDir, [createCollection()]);
      expect(enabledManager.isEnabled()).toBe(true);

      const disabledManager = await createCacheManager(tempDir, [createCollection()], {
        enabled: false,
      });
      expect(disabledManager.isEnabled()).toBe(false);
    });
  });

  describe("concurrent operations", () => {
    it("handles concurrent cache operations", async () => {
      const manager = await createCacheManager(tempDir, [createCollection()]);
      await manager.init();

      const results = Array.from({ length: 10 }, (_, i) => ({
        contentHash: `hash${i}`,
        data: { title: `Post ${i}` },
        content: `# Post ${i}`,
        slug: `post-${i}`,
        meta: {
          path: `post-${i}.md`,
          fileName: `post-${i}.md`,
          extension: ".md",
          directory: "",
          pathSegments: [],
          isIndex: false,
        },
      }));

      results.forEach((result, i) => {
        manager.setParseCache("posts", `post-${i}.md`, result);
      });

      await manager.flush();

      results.forEach((_result, i) => {
        const retrieved = manager.getParseCache("posts", `post-${i}.md`, `hash${i}`);
        expect(retrieved?.data.title).toBe(`Post ${i}`);
      });
    });
  });
});

describe("collection staleness", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-cache-staleness-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("preserves cache when schema appears unchanged (zod limitation)", async () => {
    // Note: Zod schemas serialize to {} so schema changes aren't detected
    // This is a known limitation - use clearCache option if schema changes
    const collection1 = createCollection({
      schema: z.object({ title: z.string() }),
    });

    let manager = await createCacheManager(tempDir, [collection1]);
    await manager.init();

    const parseResult = {
      contentHash: "hash",
      data: { title: "Test" },
      content: "# Test",
      slug: "test",
      meta: { path: "test.md", fileName: "test.md", extension: ".md", directory: "", pathSegments: [], isIndex: false },
    };

    manager.setParseCache("posts", "test.md", parseResult);
    await manager.flush();

    const collection2 = createCollection({
      schema: z.object({ title: z.string(), description: z.string() }),
    });

    manager = await createCacheManager(tempDir, [collection2]);
    await manager.init();

    // Schema change not detected due to zod serialization
    const retrieved = manager.getParseCache("posts", "test.md", "hash");
    expect(retrieved).toEqual(parseResult);
  });

  it("invalidates cache when transform function changes", async () => {
    const collection1 = createCollection({
      transform: (doc: Document) => ({ ...doc.data, extra: "field1" }),
    });

    let manager = await createCacheManager(tempDir, [collection1]);
    await manager.init();

    const transformResult = {
      parseHash: "hash",
      transformed: { title: "Test", extra: "field1" },
      skipped: false,
    };

    manager.setTransformCache("posts", "test", transformResult);
    await manager.flush();

    const collection2 = createCollection({
      transform: (doc: Document) => ({ ...doc.data, extra: "field2" }),
    });

    manager = await createCacheManager(tempDir, [collection2]);
    await manager.init();

    const retrieved = manager.getTransformCache("posts", "test", "hash");
    expect(retrieved).toBeNull();
  });

  it("preserves cache when collection unchanged", async () => {
    const collection = createCollection();

    let manager = await createCacheManager(tempDir, [collection]);
    await manager.init();

    const parseResult = {
      contentHash: "hash",
      data: { title: "Test" },
      content: "# Test",
      slug: "test",
      meta: { path: "test.md", fileName: "test.md", extension: ".md", directory: "", pathSegments: [], isIndex: false },
    };

    manager.setParseCache("posts", "test.md", parseResult);
    await manager.flush();

    manager = await createCacheManager(tempDir, [collection]);
    await manager.init();

    const retrieved = manager.getParseCache("posts", "test.md", "hash");
    expect(retrieved).toEqual(parseResult);
  });
});
