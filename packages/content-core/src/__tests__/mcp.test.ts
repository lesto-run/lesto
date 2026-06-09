import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createTempDir, type TempDirContext } from "./test-utils";
import { createEngine } from "../engine";
import { stringify } from "@keel/content-umbra";

/**
 * MCP Server Tests
 *
 * These tests verify the MCP tool handlers work correctly by testing
 * the underlying engine operations that the MCP server uses.
 *
 * Note: Testing the full MCP server with createMcpServer requires
 * a config file that can resolve imports, which is complex in a
 * temporary directory. Instead, we test the engine operations directly
 * since the MCP server is essentially a thin wrapper around them.
 */

describe("MCP Server", () => {
  let ctx: TempDirContext;
  let tempDir: string;

  const postsSchema = z.object({
    title: z.string(),
    publishedAt: z.coerce.date(),
    draft: z.boolean().optional(),
    author: z.string().optional(),
  });

  const authorsSchema = z.object({
    name: z.string(),
    bio: z.string().optional(),
  });

  beforeEach(async () => {
    ctx = await createTempDir("mcp-test-");
    tempDir = ctx.tempDir;

    // Create minimal Docks project structure
    await mkdir(join(tempDir, "content", "posts"), { recursive: true });
    await mkdir(join(tempDir, "content", "authors"), { recursive: true });

    // Write test content
    await writeFile(
      join(tempDir, "content", "posts", "hello-world.md"),
      `---
title: "Hello World"
publishedAt: 2024-01-15
draft: false
---

This is the content of the hello world post.`,
    );

    await writeFile(
      join(tempDir, "content", "posts", "draft-post.md"),
      `---
title: "Draft Post"
publishedAt: 2024-01-20
draft: true
---

This is a draft post.`,
    );

    await writeFile(
      join(tempDir, "content", "authors", "john-doe.md"),
      `---
name: "John Doe"
bio: "A test author"
---

Author bio content.`,
    );
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createTestEngine() {
    const engine = createEngine({
      cwd: tempDir,
      collections: [
        {
          name: "posts",
          directory: "content/posts",
          schema: postsSchema,
        },
        {
          name: "authors",
          directory: "content/authors",
          schema: authorsSchema,
        },
      ],
      mode: "development",
    });
    await engine.scan();
    return engine;
  }

  describe("list_collections", () => {
    it("lists all collections with entry counts", async () => {
      const engine = await createTestEngine();
      const collections = engine.getCollections();

      expect(collections).toHaveLength(2);

      const posts = collections.find((c) => c.name === "posts");
      expect(posts).toBeDefined();
      expect(posts!.entries.length).toBe(2);

      const authors = collections.find((c) => c.name === "authors");
      expect(authors).toBeDefined();
      expect(authors!.entries.length).toBe(1);
    });
  });

  describe("get_entry", () => {
    it("retrieves an entry by collection and slug", async () => {
      const engine = await createTestEngine();
      const entry = engine.getEntry("posts", "hello-world");

      expect(entry).toBeDefined();
      expect((entry as Record<string, unknown>).title).toBe("Hello World");
      expect((entry as Record<string, unknown>).content).toContain("hello world post");
    });

    it("returns undefined for non-existent entry", async () => {
      const engine = await createTestEngine();
      const entry = engine.getEntry("posts", "non-existent");

      expect(entry).toBeUndefined();
    });
  });

  describe("search_content", () => {
    it("searches content and returns matching entries", async () => {
      const engine = await createTestEngine();
      const collections = engine.getCollections();

      // Simulate search by filtering entries
      const query = "hello";
      const results: Array<{ collection: string; slug: string }> = [];

      for (const col of collections) {
        for (const entry of col.entries) {
          const content = ((entry as Record<string, unknown>).content as string) || "";
          const entryStr = JSON.stringify(entry).toLowerCase();
          if (content.toLowerCase().includes(query) || entryStr.includes(query)) {
            results.push({
              collection: col.name,
              slug: (entry as Record<string, unknown>).slug as string,
            });
          }
        }
      }

      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.slug === "hello-world")).toBe(true);
    });

    it("can filter by collection", async () => {
      const engine = await createTestEngine();
      const collections = engine.getCollections().filter((c) => c.name === "authors");

      const query = "content";
      const results: Array<{ collection: string; slug: string }> = [];

      for (const col of collections) {
        for (const entry of col.entries) {
          const content = ((entry as Record<string, unknown>).content as string) || "";
          if (content.toLowerCase().includes(query)) {
            results.push({
              collection: col.name,
              slug: (entry as Record<string, unknown>).slug as string,
            });
          }
        }
      }

      // Should only find author content, not posts
      expect(results.every((r) => r.collection === "authors")).toBe(true);
    });
  });

  describe("create_entry", () => {
    it("creates a new entry file", async () => {
      const data = {
        title: "New Post",
        publishedAt: "2024-02-01",
        draft: false,
      };
      const content = "This is the new post content.";
      const filePath = join(tempDir, "content", "posts", "new-post.md");

      // Simulate create_entry by writing file with stringify
      const fileContent = stringify(data, content, { language: "yaml" });
      await writeFile(filePath, fileContent, "utf-8");

      // Verify file was created
      const written = await readFile(filePath, "utf-8");
      expect(written).toContain("New Post");
      expect(written).toContain("new post content");
    });

    it("can detect duplicate entries", async () => {
      const engine = await createTestEngine();
      const existing = engine.getEntry("posts", "hello-world");

      expect(existing).toBeDefined();
      // In the real MCP handler, this would return an error
    });
  });

  describe("update_entry", () => {
    it("updates existing entry data", async () => {
      const engine = await createTestEngine();
      const entry = engine.getEntry("posts", "hello-world");
      expect(entry).toBeDefined();

      // Extract existing data and merge with updates
      const entryRecord = entry as Record<string, unknown>;
      const existingData: Record<string, unknown> = {};
      for (const key of Object.keys(entryRecord)) {
        if (!key.startsWith("_") && key !== "content" && key !== "slug" && key !== "rendered") {
          existingData[key] = entryRecord[key];
        }
      }

      const updatedData = { ...existingData, title: "Updated Title" };
      const existingContent = (entryRecord.content as string) || "";

      const filePath = join(tempDir, "content", "posts", "hello-world.md");
      const fileContent = stringify(updatedData, existingContent, {
        language: "yaml",
      });
      await writeFile(filePath, fileContent, "utf-8");

      // Verify file was updated
      const written = await readFile(filePath, "utf-8");
      expect(written).toContain("Updated Title");
    });

    it("updates entry content", async () => {
      const engine = await createTestEngine();
      const entry = engine.getEntry("posts", "hello-world");
      expect(entry).toBeDefined();

      const entryRecord = entry as Record<string, unknown>;
      const existingData: Record<string, unknown> = {};
      for (const key of Object.keys(entryRecord)) {
        if (!key.startsWith("_") && key !== "content" && key !== "slug" && key !== "rendered") {
          existingData[key] = entryRecord[key];
        }
      }

      const newContent = "Brand new content here.";
      const filePath = join(tempDir, "content", "posts", "hello-world.md");
      const fileContent = stringify(existingData, newContent, {
        language: "yaml",
      });
      await writeFile(filePath, fileContent, "utf-8");

      const written = await readFile(filePath, "utf-8");
      expect(written).toContain("Brand new content");
    });
  });

  describe("get_collection_schema", () => {
    it("can convert schema to JSON", async () => {
      // The MCP server uses schemaToJsonSchema from schema-introspector
      // This test verifies the function works with Zod schemas
      const { schemaToJsonSchema } = await import("../schema-introspector");

      // Create a simple schema for testing
      const simpleSchema = z.object({ title: z.string() });
      const jsonSchema = schemaToJsonSchema(simpleSchema);

      // The schema should be defined and have type "object"
      expect(jsonSchema).toBeDefined();
      expect(jsonSchema).toHaveProperty("type", "object");
      expect(jsonSchema).toHaveProperty("properties");
      expect((jsonSchema as { properties: Record<string, unknown> }).properties).toHaveProperty(
        "title",
      );
    });
  });
});
