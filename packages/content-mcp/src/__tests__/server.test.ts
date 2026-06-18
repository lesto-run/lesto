import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createEngine, type ResolvedConfig } from "@volo/content-core/build";
import { createTempDir, type TempDirContext } from "./test-utils";
import { handleCreateEntry, handleUpdateEntry } from "../server";

/**
 * Tests for the standalone (filesystem-backed) MCP server handlers.
 *
 * The two write handlers carry security guarantees ported from content-core:
 *   - create_entry validates frontmatter against the collection's Standard
 *     Schema before writing (and guards against path traversal).
 *   - update_entry strips engine-internal EntryMeta so id/collection/file never
 *     leak into the persisted frontmatter.
 */

const postsSchema = z.object({
  title: z.string(),
  publishedAt: z.coerce.date(),
  draft: z.boolean().optional(),
});

describe("standalone MCP server handlers", () => {
  let ctx: TempDirContext;
  let tempDir: string;

  beforeEach(async () => {
    ctx = await createTempDir("mcp-server-");
    tempDir = ctx.tempDir;
    await mkdir(join(tempDir, "content", "posts"), { recursive: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function setup() {
    const collections = [{ name: "posts", directory: "content/posts", schema: postsSchema }];
    const engine = createEngine({ cwd: tempDir, collections, mode: "development" });
    await engine.scan();

    const config: ResolvedConfig = {
      configPath: null,
      cwd: tempDir,
      collections,
      taxonomies: [],
      mode: "development",
    };

    return { engine, config };
  }

  async function seedHelloWorld() {
    await writeFile(
      join(tempDir, "content", "posts", "hello-world.md"),
      `---\ntitle: "Hello World"\npublishedAt: 2024-01-15\ndraft: false\n---\n\nBody.`,
    );
  }

  describe("create_entry schema validation", () => {
    it("rejects data that violates the schema and writes no file", async () => {
      const { engine, config } = await setup();

      // Missing required "title".
      const result = await handleCreateEntry(engine, config, {
        collection: "posts",
        slug: "bad-entry",
        data: { publishedAt: "2024-01-01" },
      });

      expect(result).toContain("does not match");
      await expect(
        readFile(join(tempDir, "content", "posts", "bad-entry.md"), "utf-8"),
      ).rejects.toThrow();
    });

    it("accepts data that satisfies the schema", async () => {
      const { engine, config } = await setup();

      const result = await handleCreateEntry(engine, config, {
        collection: "posts",
        slug: "good-entry",
        data: { title: "Hello", publishedAt: "2024-01-01" },
        content: "Body",
      });

      expect(result).toContain("Successfully created");
      const written = await readFile(join(tempDir, "content", "posts", "good-entry.md"), "utf-8");
      expect(written).toContain("Hello");
    });
  });

  describe("create_entry guards", () => {
    it("rejects a path-traversal slug before validating or writing", async () => {
      const { engine, config } = await setup();

      const result = await handleCreateEntry(engine, config, {
        collection: "posts",
        slug: "../escape",
        data: { title: "Hello", publishedAt: "2024-01-01" },
      });

      expect(result).toContain("Invalid slug");
    });

    it("rejects a slug with forbidden filename characters", async () => {
      const { engine, config } = await setup();

      const result = await handleCreateEntry(engine, config, {
        collection: "posts",
        slug: "bad?name",
        data: { title: "Hello", publishedAt: "2024-01-01" },
      });

      expect(result).toContain("Invalid slug");
    });

    it("rejects an empty slug", async () => {
      const { engine, config } = await setup();

      const result = await handleCreateEntry(engine, config, {
        collection: "posts",
        slug: "",
        data: { title: "Hello", publishedAt: "2024-01-01" },
      });

      expect(result).toContain("Invalid slug");
    });

    it("rejects creating an entry that already exists", async () => {
      await seedHelloWorld();
      const { engine, config } = await setup();

      const result = await handleCreateEntry(engine, config, {
        collection: "posts",
        slug: "hello-world",
        data: { title: "Hello", publishedAt: "2024-01-01" },
      });

      expect(result).toContain("already exists");
    });

    it("rejects an unknown collection", async () => {
      const { engine, config } = await setup();

      const result = await handleCreateEntry(engine, config, {
        collection: "ghosts",
        slug: "x",
        data: { title: "Hello", publishedAt: "2024-01-01" },
      });

      expect(result).toContain("not found");
    });

    it("returns a write error when the target directory is missing", async () => {
      const collections = [
        { name: "posts", directory: "content/does-not-exist", schema: postsSchema },
      ];
      const engine = createEngine({ cwd: tempDir, collections, mode: "development" });
      await engine.scan();
      const config: ResolvedConfig = {
        configPath: null,
        cwd: tempDir,
        collections,
        taxonomies: [],
        mode: "development",
      };

      const result = await handleCreateEntry(engine, config, {
        collection: "posts",
        slug: "x",
        data: { title: "Hello", publishedAt: "2024-01-01" },
      });

      expect(result).toContain("Error writing file");
    });
  });

  describe("update_entry frontmatter hygiene", () => {
    it("does not persist engine-internal id/collection/file into frontmatter", async () => {
      await seedHelloWorld();
      const { engine, config } = await setup();

      const result = await handleUpdateEntry(engine, config, {
        collection: "posts",
        slug: "hello-world",
        data: { title: "Updated Title" },
      });

      expect(result).toContain("Successfully updated");

      const written = await readFile(join(tempDir, "content", "posts", "hello-world.md"), "utf-8");

      // The author's edit survives.
      expect(written).toContain("Updated Title");

      // Engine-internal metadata must NOT leak into the YAML frontmatter.
      expect(written).not.toContain("id:");
      expect(written).not.toContain("collection:");
      // The `file` DocumentMeta object would serialize its nested keys.
      expect(written).not.toContain("pathSegments");
      expect(written).not.toContain("fileName");
      expect(written).not.toContain("isIndex");
    });

    it("replaces content when provided and preserves it otherwise", async () => {
      await seedHelloWorld();
      const { engine, config } = await setup();

      const withContent = await handleUpdateEntry(engine, config, {
        collection: "posts",
        slug: "hello-world",
        content: "Brand new content here.",
      });
      expect(withContent).toContain("Successfully updated");
      let written = await readFile(join(tempDir, "content", "posts", "hello-world.md"), "utf-8");
      expect(written).toContain("Brand new content");

      // Re-scan picks up the new content; a data-only update must keep it.
      const dataOnly = await handleUpdateEntry(engine, config, {
        collection: "posts",
        slug: "hello-world",
        data: { draft: true },
      });
      expect(dataOnly).toContain("Successfully updated");
      written = await readFile(join(tempDir, "content", "posts", "hello-world.md"), "utf-8");
      expect(written).toContain("Brand new content");
      expect(written).toContain("draft: true");
    });

    it("rejects updating a non-existent entry", async () => {
      const { engine, config } = await setup();

      const result = await handleUpdateEntry(engine, config, {
        collection: "posts",
        slug: "ghost",
      });

      expect(result).toContain("not found");
    });

    it("rejects updating in an unknown collection", async () => {
      await seedHelloWorld();
      const { engine, config } = await setup();

      // Entry resolves, but config lookup is what fails: simulate by removing it.
      const brokenConfig: ResolvedConfig = { ...config, collections: [] };

      const result = await handleUpdateEntry(engine, brokenConfig, {
        collection: "posts",
        slug: "hello-world",
      });

      expect(result).toContain("not found");
    });
  });
});
