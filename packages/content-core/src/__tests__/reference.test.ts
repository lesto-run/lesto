import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { reference, isReference, getReferenceTarget } from "../reference";
import { runPipeline } from "../pipeline";

// `reference()` is schema-library-agnostic and returns `unknown`; in these
// Zod-based tests it always yields a Zod string schema.
const ref = (collectionName: string): z.ZodString => reference(collectionName) as z.ZodString;

describe("reference", () => {
  describe("reference()", () => {
    it("returns a Zod-compatible schema", () => {
      const schema = ref("authors");

      // Should be a Zod string schema
      expect(() => schema.parse("john-doe")).not.toThrow();
      expect(() => schema.parse(123)).toThrow();
    });

    it("stores reference metadata correctly", () => {
      const schema = reference("authors");

      expect(isReference(schema)).toBe(true);
      expect(getReferenceTarget(schema)).toBe("authors");
    });

    it("can be used in array schemas", () => {
      const schema = ref("posts").array().max(3);

      expect(() => schema.parse(["post-1", "post-2"])).not.toThrow();
      expect(() => schema.parse(["post-1", "post-2", "post-3", "post-4"])).toThrow();
    });
  });

  describe("isReference()", () => {
    it("correctly identifies reference schemas", () => {
      const refSchema = reference("authors");
      const stringSchema = z.string();

      expect(isReference(refSchema)).toBe(true);
      expect(isReference(stringSchema)).toBe(false);
      expect(isReference(null)).toBe(false);
      expect(isReference(undefined)).toBe(false);
      expect(isReference({})).toBe(false);
    });
  });

  describe("getReferenceTarget()", () => {
    it("extracts the collection name", () => {
      const schema = reference("authors");
      expect(getReferenceTarget(schema)).toBe("authors");
    });

    it("returns undefined for non-reference schemas", () => {
      const schema = z.string();
      expect(getReferenceTarget(schema)).toBeUndefined();
    });
  });
});

describe("reference validation in pipeline", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-ref-test-"));
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

  it("validates valid single references without errors", async () => {
    await setupProject([
      { path: "content/authors/john.md", frontmatter: { name: "John Doe" }, content: "Bio" },
      {
        path: "content/posts/hello.md",
        frontmatter: { title: "Hello", author: "john" },
        content: "Post content",
      },
    ]);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    try {
      await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "authors",
              directory: "content/authors",
              schema: z.object({ name: z.string() }),
            },
            {
              name: "posts",
              directory: "content/posts",
              schema: z.object({
                title: z.string(),
                author: reference("authors"),
              }),
            },
          ],
        },
        skipWrite: true,
      });

      const refWarnings = warnings.filter((w) => w.includes("Reference error"));
      expect(refWarnings).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("reports errors for broken single references", async () => {
    await setupProject([
      { path: "content/authors/john.md", frontmatter: { name: "John Doe" }, content: "Bio" },
      {
        path: "content/posts/hello.md",
        frontmatter: { title: "Hello", author: "jane" }, // jane doesn't exist
        content: "Post content",
      },
    ]);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    try {
      await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "authors",
              directory: "content/authors",
              schema: z.object({ name: z.string() }),
            },
            {
              name: "posts",
              directory: "content/posts",
              schema: z.object({
                title: z.string(),
                author: reference("authors"),
              }),
            },
          ],
        },
        skipWrite: true,
      });

      const refWarnings = warnings.filter((w) => w.includes("Reference error"));
      expect(refWarnings.length).toBeGreaterThan(0);
      expect(refWarnings[0]).toContain('references non-existent authors/jane');
    } finally {
      console.warn = originalWarn;
    }
  });

  it("validates array references correctly", async () => {
    await setupProject([
      { path: "content/posts/post-1.md", frontmatter: { title: "Post 1" }, content: "Content 1" },
      { path: "content/posts/post-2.md", frontmatter: { title: "Post 2" }, content: "Content 2" },
      {
        path: "content/posts/main.md",
        frontmatter: { title: "Main", related: ["post-1", "post-2"] },
        content: "Main content",
      },
    ]);

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
              schema: z.object({
                title: z.string(),
                related: ref("posts").array().optional(),
              }),
            },
          ],
        },
        skipWrite: true,
      });

      const refWarnings = warnings.filter((w) => w.includes("Reference error"));
      expect(refWarnings).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("reports errors for broken array references", async () => {
    await setupProject([
      { path: "content/posts/post-1.md", frontmatter: { title: "Post 1" }, content: "Content 1" },
      {
        path: "content/posts/main.md",
        frontmatter: { title: "Main", related: ["post-1", "post-2", "post-3"] }, // post-2 and post-3 don't exist
        content: "Main content",
      },
    ]);

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
              schema: z.object({
                title: z.string(),
                related: ref("posts").array().optional(),
              }),
            },
          ],
        },
        skipWrite: true,
      });

      const refWarnings = warnings.filter((w) => w.includes("Reference error"));
      expect(refWarnings.length).toBeGreaterThan(0);
      expect(refWarnings.some((w) => w.includes("post-2"))).toBe(true);
      expect(refWarnings.some((w) => w.includes("post-3"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("validates array of optional references (optional before array)", async () => {
    await setupProject([
      { path: "content/posts/post-1.md", frontmatter: { title: "Post 1" }, content: "Content 1" },
      { path: "content/posts/post-2.md", frontmatter: { title: "Post 2" }, content: "Content 2" },
      {
        path: "content/posts/main.md",
        frontmatter: { title: "Main", related: ["post-1", "post-2"] },
        content: "Main content",
      },
    ]);

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
              schema: z.object({
                title: z.string(),
                // This is an array of optional references - edge case
                related: ref("posts").optional().array().optional(),
              }),
            },
          ],
        },
        skipWrite: true,
      });

      const refWarnings = warnings.filter((w) => w.includes("Reference error"));
      expect(refWarnings).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("skips validation for missing/undefined references", async () => {
    await setupProject([
      { path: "content/authors/john.md", frontmatter: { name: "John Doe" }, content: "Bio" },
      {
        path: "content/posts/hello.md",
        frontmatter: { title: "Hello" }, // author field is missing
        content: "Post content",
      },
    ]);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    try {
      await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            {
              name: "authors",
              directory: "content/authors",
              schema: z.object({ name: z.string() }),
            },
            {
              name: "posts",
              directory: "content/posts",
              schema: z.object({
                title: z.string(),
                author: ref("authors").optional(),
              }),
            },
          ],
        },
        skipWrite: true,
      });

      const refWarnings = warnings.filter((w) => w.includes("Reference error"));
      expect(refWarnings).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("reports errors for references to unknown collections", async () => {
    await setupProject([
      {
        path: "content/posts/hello.md",
        frontmatter: { title: "Hello", author: "john" },
        content: "Post content",
      },
    ]);

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
              schema: z.object({
                title: z.string(),
                author: reference("authors"), // authors collection doesn't exist
              }),
            },
          ],
        },
        skipWrite: true,
      });

      const refWarnings = warnings.filter((w) => w.includes("Reference error"));
      expect(refWarnings.length).toBeGreaterThan(0);
      expect(refWarnings[0]).toContain('references unknown collection "authors"');
    } finally {
      console.warn = originalWarn;
    }
  });
});
