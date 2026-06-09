/**
 * Standard Schema Multi-Library Tests
 *
 * Tests that the pipeline works correctly with multiple Standard Schema
 * compatible libraries. This ensures we're truly schema-agnostic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nn } from "./test-utils";
import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import * as v from "valibot";
import { runPipeline } from "../pipeline";
import { isStandardSchema, getSchemaDef, schemaToJsonSchema } from "../schema-introspector";
import { markAsReference, isReference, getReferenceTarget } from "../reference";
import type { CollectionSchema } from "../types";

describe("Standard Schema Multi-Library Support", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-ss-test-"));
    await mkdir(path.join(tempDir, "content", "posts"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const writePost = async (slug: string, frontmatter: Record<string, unknown>, content: string) => {
    const fm = Object.entries(frontmatter)
      .map(([k, val]) => `${k}: ${JSON.stringify(val)}`)
      .join("\n");
    await writeFile(
      path.join(tempDir, "content", "posts", `${slug}.md`),
      `---\n${fm}\n---\n\n${content}`,
    );
  };

  describe("Schema Detection", () => {
    it("detects Zod schemas as Standard Schema", () => {
      const schema = z.object({ title: z.string() });
      expect(isStandardSchema(schema)).toBe(true);
    });

    it("detects Valibot schemas as Standard Schema", () => {
      const schema = v.object({ title: v.string() });
      expect(isStandardSchema(schema)).toBe(true);
    });

    it("returns false for plain objects", () => {
      expect(isStandardSchema({})).toBe(false);
      expect(isStandardSchema({ type: "object" })).toBe(false);
    });
  });

  describe("Schema Introspection", () => {
    it("introspects Zod object schema", () => {
      const schema = z.object({
        title: z.string(),
        count: z.number(),
      });
      const def = getSchemaDef(schema);
      expect(def).toBeDefined();
      expect(def?.type).toBe("object");
      expect(def?.shape).toBeDefined();
    });

    it("returns undefined for Valibot schemas (limited introspection)", () => {
      // Valibot doesn't expose a .def property like Zod
      // So introspection falls back
      const schema = v.object({ title: v.string() });
      const def = getSchemaDef(schema);
      // Valibot doesn't have Zod's .def structure
      expect(def).toBeUndefined();
    });
  });

  describe("JSON Schema Conversion", () => {
    it("converts Zod schema to JSON Schema", () => {
      const schema = z.object({
        title: z.string(),
        draft: z.boolean().optional(),
      });
      const jsonSchema = schemaToJsonSchema(schema);
      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties).toBeDefined();
      expect(jsonSchema.properties?.title).toEqual({ type: "string" });
      expect(jsonSchema.required).toContain("title");
      expect(jsonSchema.required).not.toContain("draft");
    });

    it("returns minimal object schema for Valibot (fallback)", () => {
      const schema = v.object({ title: v.string() });
      const jsonSchema = schemaToJsonSchema(schema);
      // Without StandardJSONSchemaV1 or Zod introspection, falls back
      expect(jsonSchema.type).toBe("object");
    });
  });

  describe("markAsReference (Schema-Agnostic)", () => {
    it("works with Zod string schema", () => {
      const schema = markAsReference(z.string(), "authors");
      expect(isReference(schema)).toBe(true);
      expect(getReferenceTarget(schema)).toBe("authors");
    });

    it("works with Valibot string schema", () => {
      const schema = markAsReference(v.string(), "posts");
      expect(isReference(schema)).toBe(true);
      expect(getReferenceTarget(schema)).toBe("posts");
    });

    it("works with plain objects as fallback", () => {
      const schema = markAsReference({ type: "string" }, "tags");
      expect(isReference(schema)).toBe(true);
      expect(getReferenceTarget(schema)).toBe("tags");
    });
  });

  describe("Pipeline with Zod", () => {
    it("validates and processes entries with Zod schema", async () => {
      await writePost("hello", { title: "Hello World", draft: false }, "Content here");

      const zodSchema = z.object({
        title: z.string(),
        draft: z.boolean().default(false),
      });

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "posts",
              directory: "content/posts",
              schema: zodSchema,
            },
          ],
        },
        skipWrite: true,
      });

      expect(result.entries.length).toBe(1);
      expect(nn(result.entries[0])["title"]).toBe("Hello World");
      expect(nn(result.entries[0])["draft"]).toBe(false);
    });

    it("validates with Zod schema and reports errors", async () => {
      await writePost("bad", { title: 123 }, "Content"); // title should be string

      const zodSchema = z.object({
        title: z.string(),
      });

      // Capture console.warn to check for validation messages
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: string) => warnings.push(msg);

      try {
        await runPipeline({
          cwd: tempDir,
          config: {
            collections: [
              {
                name: "posts",
                directory: "content/posts",
                schema: zodSchema,
              },
            ],
          },
          skipWrite: true,
        });

        // Invalid entries are filtered out of the result
        // But validation errors are logged
        expect(warnings.some((w) => w.includes("Validation failed"))).toBe(true);
        expect(warnings.some((w) => w.includes("title"))).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("Pipeline with Valibot", () => {
    it("validates and processes entries with Valibot schema", async () => {
      await writePost("hello", { title: "Hello World", draft: false }, "Content here");

      const valibotSchema = v.object({
        title: v.string(),
        draft: v.optional(v.boolean(), false),
      });

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "posts",
              directory: "content/posts",
              schema: valibotSchema as CollectionSchema,
            },
          ],
        },
        skipWrite: true,
      });

      expect(result.entries.length).toBe(1);
      expect(nn(result.entries[0])["title"]).toBe("Hello World");
    });

    it("validates with Valibot schema and reports errors", async () => {
      await writePost("bad", { title: 123 }, "Content"); // title should be string

      const valibotSchema = v.object({
        title: v.string(),
      });

      // Capture console.warn to check for validation messages
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: string) => warnings.push(msg);

      try {
        await runPipeline({
          cwd: tempDir,
          config: {
            collections: [
              {
                name: "posts",
                directory: "content/posts",
                schema: valibotSchema as CollectionSchema,
              },
            ],
          },
          skipWrite: true,
        });

        // Invalid entries are filtered out of the result
        // But validation errors are logged
        expect(warnings.some((w) => w.includes("Validation failed"))).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("Type Generation Compatibility", () => {
    it("generates types from Zod schema", () => {
      const zodSchema = z.object({
        title: z.string(),
        tags: z.array(z.string()).optional(),
      });

      // getSchemaDef is our introspection function
      const def = getSchemaDef(zodSchema);
      expect(def).toBeDefined();
      expect(def?.type).toBe("object");
      expect(def?.shape).toBeDefined();

      // Verify shape contains expected fields
      const shape = def?.shape as Record<string, unknown>;
      expect(shape["title"]).toBeDefined();
      expect(shape["tags"]).toBeDefined();
    });

    it("falls back for non-introspectable schemas", () => {
      const valibotSchema = v.object({
        title: v.string(),
      });

      // Valibot doesn't have Zod's .def structure
      const def = getSchemaDef(valibotSchema);
      expect(def).toBeUndefined();

      // But JSON Schema conversion should still return minimal object type
      const jsonSchema = schemaToJsonSchema(valibotSchema);
      expect(jsonSchema.type).toBe("object");
    });
  });
});
