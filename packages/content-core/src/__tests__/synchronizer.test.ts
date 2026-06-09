import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nn } from "./test-utils";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSynchronizer } from "../synchronizer";
import type { ResolvedConfig } from "../config";
import type { RuntimeEntry } from "../types";
import { z } from "zod";

/** Build a minimal runtime entry for synchronizer state assertions. */
function entryStub(id: string, extra: Record<string, unknown> = {}): RuntimeEntry {
  const [collection, ...rest] = id.split("/");
  const slug = rest.join("/") || id;
  return {
    id,
    collection: collection ?? "",
    file: {
      path: `${slug}.md`,
      fileName: slug,
      extension: "md",
      directory: ".",
      pathSegments: [slug],
      isIndex: false,
    },
    slug,
    content: "",
    ...extra,
  };
}

describe("synchronizer", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-test-"));
    await mkdir(path.join(tempDir, "content", "posts"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const createConfig = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
    configPath: null,
    cwd: tempDir,
    collections: [
      {
        name: "posts",
        directory: "content/posts",
        schema: z.object({ title: z.string() }),
      },
    ],
    taxonomies: [],
    mode: "development" as const,
    ...overrides,
  });

  const createFile = async (name: string, title: string) => {
    const filePath = path.join(tempDir, "content", "posts", `${name}.md`);
    await writeFile(filePath, `---\ntitle: "${title}"\n---\n\nContent`);
    return filePath;
  };

  describe("initialize", () => {
    it("populates state from entries", () => {
      const sync = createSynchronizer(createConfig());
      const entries = [entryStub("posts/hello", { title: "Hello" })];

      sync.initialize(entries, new Map([["/path/to/hello.md", "posts/hello"]]));

      expect(sync.getEntries()).toHaveLength(1);
      expect(sync.getCollection("posts")).toHaveLength(1);
    });

    it("clears existing state on re-initialize", () => {
      const sync = createSynchronizer(createConfig());

      const entries1 = [entryStub("posts/first")];

      const entries2 = [entryStub("posts/second")];

      sync.initialize(entries1, new Map([["/first.md", "posts/first"]]));
      expect(sync.getEntries()).toHaveLength(1);
      expect(sync.getEntry("posts", "first")).toBeDefined();

      sync.initialize(entries2, new Map([["/second.md", "posts/second"]]));
      expect(sync.getEntries()).toHaveLength(1);
      expect(sync.getEntry("posts", "first")).toBeUndefined();
      expect(sync.getEntry("posts", "second")).toBeDefined();
    });
  });

  describe("changed", () => {
    it("adds new files", async () => {
      const sync = createSynchronizer(createConfig());
      sync.initialize([], new Map());

      const filePath = await createFile("new", "New Post");
      const result = await sync.changed(filePath);

      expect(result?.type).toBe("added");
      expect(result?.entry?.slug).toBe("new");
      expect(sync.getEntries()).toHaveLength(1);
    });

    it("updates existing files", async () => {
      const sync = createSynchronizer(createConfig());
      const filePath = await createFile("existing", "Original");

      // First add
      await sync.changed(filePath);
      // Data is now flattened - access title directly
      expect(nn(sync.getEntries()[0]).title).toBe("Original");

      // Update
      await writeFile(filePath, `---\ntitle: "Updated"\n---\n\nNew content`);
      const result = await sync.changed(filePath);

      expect(result?.type).toBe("changed");
      expect(result?.entry?.title).toBe("Updated");
      expect(sync.getEntries()).toHaveLength(1);
    });

    it("handles skipped documents", async () => {
      const config = createConfig();
      nn(config.collections[0]).transform = (_document, ctx) => ctx.skip();

      const sync = createSynchronizer(config);
      sync.initialize([], new Map());

      const filePath = await createFile("skip", "Skip Me");
      const result = await sync.changed(filePath);

      expect(result?.type).toBe("skipped");
      expect(sync.getEntries()).toHaveLength(0);
    });

    it("returns null for non-matching paths", async () => {
      const sync = createSynchronizer(createConfig());
      sync.initialize([], new Map());

      const result = await sync.changed("/some/random/path.md");

      expect(result).toBeNull();
    });

    it("handles slug changes", async () => {
      const sync = createSynchronizer(createConfig());
      sync.initialize([], new Map());

      // Add file
      const filePath = await createFile("original-slug", "Title");
      await sync.changed(filePath);
      expect(sync.getEntry("posts", "original-slug")).toBeDefined();

      // Rename file (simulated by deleting old and creating new)
      await rm(filePath);
      const newPath = await createFile("new-slug", "Title");

      // Process delete and add
      sync.deleted(filePath);
      await sync.changed(newPath);

      expect(sync.getEntry("posts", "original-slug")).toBeUndefined();
      expect(sync.getEntry("posts", "new-slug")).toBeDefined();
      expect(sync.getEntries()).toHaveLength(1);
    });

    it("handles parse errors gracefully", async () => {
      const sync = createSynchronizer(createConfig());
      sync.initialize([], new Map());

      // Create file with invalid frontmatter
      const filePath = path.join(tempDir, "content", "posts", "invalid.md");
      await writeFile(filePath, `---\ntitle: 123\n---\n\nInvalid`);

      // Should return skipped, not throw
      const result = await sync.changed(filePath);
      expect(result?.type).toBe("skipped");
    });
  });

  describe("deleted", () => {
    it("removes files from state", async () => {
      const sync = createSynchronizer(createConfig());
      const filePath = await createFile("delete", "Delete Me");

      await sync.changed(filePath);
      expect(sync.getEntries()).toHaveLength(1);

      const result = sync.deleted(filePath);

      expect(result?.type).toBe("deleted");
      expect(result?.entry?.slug).toBe("delete");
      expect(sync.getEntries()).toHaveLength(0);
    });

    it("returns skipped for unknown files", async () => {
      const sync = createSynchronizer(createConfig());
      sync.initialize([], new Map());

      const filePath = path.join(tempDir, "content", "posts", "unknown.md");
      const result = sync.deleted(filePath);

      expect(result?.type).toBe("skipped");
    });

    it("returns null for non-matching paths", () => {
      const sync = createSynchronizer(createConfig());
      sync.initialize([], new Map());

      const result = sync.deleted("/some/random/path.md");

      expect(result).toBeNull();
    });

    it("removes entry from collection list", async () => {
      const sync = createSynchronizer(createConfig());
      const filePath1 = await createFile("first", "First");
      const filePath2 = await createFile("second", "Second");

      await sync.changed(filePath1);
      await sync.changed(filePath2);
      expect(sync.getCollection("posts")).toHaveLength(2);

      sync.deleted(filePath1);
      expect(sync.getCollection("posts")).toHaveLength(1);
      expect(nn(sync.getCollection("posts")[0]).slug).toBe("second");
    });
  });

  describe("getEntry", () => {
    it("retrieves entry by collection and slug", async () => {
      const sync = createSynchronizer(createConfig());
      const filePath = await createFile("test", "Test");

      await sync.changed(filePath);

      const entry = sync.getEntry("posts", "test");
      // New flattened structure
      expect(entry?.id).toBe("posts/test");
      expect(entry?.title).toBe("Test");
    });

    it("returns undefined for non-existent entry", () => {
      const sync = createSynchronizer(createConfig());
      sync.initialize([], new Map());

      expect(sync.getEntry("posts", "nonexistent")).toBeUndefined();
    });
  });

  describe("getCollection", () => {
    it("returns all entries for a collection", async () => {
      const sync = createSynchronizer(createConfig());

      await createFile("first", "First").then((p) => sync.changed(p));
      await createFile("second", "Second").then((p) => sync.changed(p));

      const posts = sync.getCollection("posts");
      expect(posts).toHaveLength(2);
    });

    it("returns empty array for unknown collection", () => {
      const sync = createSynchronizer(createConfig());
      sync.initialize([], new Map());

      expect(sync.getCollection("unknown")).toEqual([]);
    });
  });

  describe("getState", () => {
    it("returns internal state", async () => {
      const sync = createSynchronizer(createConfig());
      const filePath = await createFile("test", "Test");

      await sync.changed(filePath);

      const state = sync.getState();
      expect(state.entries).toBeInstanceOf(Map);
      expect(state.pathToId).toBeInstanceOf(Map);
      expect(state.byCollection).toBeInstanceOf(Map);
      expect(state.entries.size).toBe(1);
    });
  });

  describe("multiple collections", () => {
    it("handles files from different collections", async () => {
      await mkdir(path.join(tempDir, "content", "pages"), { recursive: true });

      const config = createConfig({
        collections: [
          {
            name: "posts",
            directory: "content/posts",
            schema: z.object({ title: z.string() }),
          },
          {
            name: "pages",
            directory: "content/pages",
            schema: z.object({ title: z.string() }),
          },
        ],
      });

      const sync = createSynchronizer(config);
      sync.initialize([], new Map());

      const postPath = await createFile("post", "Post");
      const pagePath = path.join(tempDir, "content", "pages", "about.md");
      await writeFile(pagePath, `---\ntitle: "About"\n---\n\nAbout page`);

      await sync.changed(postPath);
      await sync.changed(pagePath);

      expect(sync.getCollection("posts")).toHaveLength(1);
      expect(sync.getCollection("pages")).toHaveLength(1);
      expect(sync.getEntries()).toHaveLength(2);
    });
  });

  describe("include/exclude patterns", () => {
    it("respects include patterns", async () => {
      const config = createConfig({
        collections: [
          {
            name: "posts",
            directory: "content/posts",
            schema: z.object({ title: z.string() }),
            include: "**/*.mdx",
          },
        ],
      });

      const sync = createSynchronizer(config);
      sync.initialize([], new Map());

      const mdPath = await createFile("test", "Test");
      const mdxPath = path.join(tempDir, "content", "posts", "test.mdx");
      await writeFile(mdxPath, `---\ntitle: "MDX"\n---\n\nMDX content`);

      const mdResult = await sync.changed(mdPath);
      const mdxResult = await sync.changed(mdxPath);

      // MD file should not match
      expect(mdResult).toBeNull();
      // MDX file should match
      expect(mdxResult?.type).toBe("added");
    });
  });
});
