import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nn } from "./test-utils";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { defineTaxonomy, isEnumTaxonomy, isSchemaTaxonomy, getTaxonomySlugs } from "../taxonomy";
import { reference } from "../reference";
import { runPipeline } from "../pipeline";
import { generateTypes } from "../typegen";

// `reference()` returns `unknown` (schema-library-agnostic); here it is Zod.
const ref = (collectionName: string): z.ZodString => reference(collectionName) as z.ZodString;

describe("defineTaxonomy", () => {
  describe("enum taxonomy", () => {
    it("creates an enum taxonomy with string terms", () => {
      const status = defineTaxonomy({
        name: "status",
        terms: ["draft", "published", "archived"],
      });

      expect(status.name).toBe("status");
      expect(status.terms).toEqual(["draft", "published", "archived"]);
    });

    it("identifies enum taxonomy correctly", () => {
      const status = defineTaxonomy({
        name: "status",
        terms: ["draft", "published"],
      });

      expect(isEnumTaxonomy(status)).toBe(true);
      expect(isSchemaTaxonomy(status)).toBe(false);
    });

    it("extracts slugs from enum taxonomy", () => {
      const status = defineTaxonomy({
        name: "status",
        terms: ["draft", "published", "archived"],
      });

      expect(getTaxonomySlugs(status)).toEqual(["draft", "published", "archived"]);
    });
  });

  describe("schema taxonomy", () => {
    it("creates a schema taxonomy with rich terms", () => {
      const tags = defineTaxonomy({
        name: "tags",
        schema: z.object({
          name: z.string(),
          description: z.string().optional(),
          color: z.string().optional(),
        }),
        terms: [
          { slug: "javascript", name: "JavaScript", color: "#f7df1e" },
          { slug: "typescript", name: "TypeScript", description: "Typed JS", color: "#3178c6" },
        ],
      });

      expect(tags.name).toBe("tags");
      expect(tags.terms).toHaveLength(2);
      expect(nn(tags.terms[0]).slug).toBe("javascript");
      expect(nn(tags.terms[0]).name).toBe("JavaScript");
    });

    it("identifies schema taxonomy correctly", () => {
      const tags = defineTaxonomy({
        name: "tags",
        schema: z.object({ name: z.string() }),
        terms: [{ slug: "js", name: "JavaScript" }],
      });

      expect(isSchemaTaxonomy(tags)).toBe(true);
      expect(isEnumTaxonomy(tags)).toBe(false);
    });

    it("extracts slugs from schema taxonomy", () => {
      const tags = defineTaxonomy({
        name: "tags",
        schema: z.object({ name: z.string() }),
        terms: [
          { slug: "js", name: "JavaScript" },
          { slug: "ts", name: "TypeScript" },
          { slug: "react", name: "React" },
        ],
      });

      expect(getTaxonomySlugs(tags)).toEqual(["js", "ts", "react"]);
    });
  });

  describe("edge cases", () => {
    it("handles empty terms array for enum", () => {
      const empty = defineTaxonomy({
        name: "empty",
        terms: [] as const,
      });

      expect(isEnumTaxonomy(empty)).toBe(true);
      expect(getTaxonomySlugs(empty)).toEqual([]);
    });
  });
});

describe("taxonomy validation in pipeline", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-tax-test-"));
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

  it("validates valid taxonomy references", async () => {
    await setupProject([
      {
        path: "content/posts/hello.md",
        frontmatter: { title: "Hello", status: "published" },
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
                status: reference("status"),
              }),
            },
          ],
          taxonomies: [
            defineTaxonomy({
              name: "status",
              terms: ["draft", "published", "archived"],
            }),
          ],
        },
        skipWrite: true,
      });

      const errors = warnings.filter((w) => w.includes("taxonomy term") || w.includes("invalid"));
      expect(errors).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("reports errors for invalid taxonomy references", async () => {
    await setupProject([
      {
        path: "content/posts/hello.md",
        frontmatter: { title: "Hello", status: "unknown-status" },
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
                status: reference("status"),
              }),
            },
          ],
          taxonomies: [
            defineTaxonomy({
              name: "status",
              terms: ["draft", "published", "archived"],
            }),
          ],
        },
        skipWrite: true,
      });

      const errors = warnings.filter((w) => w.includes("unknown-status"));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("taxonomy term");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("validates array taxonomy references", async () => {
    await setupProject([
      {
        path: "content/posts/hello.md",
        frontmatter: { title: "Hello", tags: ["javascript", "typescript"] },
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
                tags: ref("tags").array(),
              }),
            },
          ],
          taxonomies: [
            defineTaxonomy({
              name: "tags",
              schema: z.object({ name: z.string() }),
              terms: [
                { slug: "javascript", name: "JavaScript" },
                { slug: "typescript", name: "TypeScript" },
              ],
            }),
          ],
        },
        skipWrite: true,
      });

      const errors = warnings.filter((w) => w.includes("taxonomy term") || w.includes("invalid"));
      expect(errors).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("reports errors for invalid array taxonomy references", async () => {
    await setupProject([
      {
        path: "content/posts/hello.md",
        frontmatter: { title: "Hello", tags: ["javascript", "python", "rust"] },
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
                tags: ref("tags").array(),
              }),
            },
          ],
          taxonomies: [
            defineTaxonomy({
              name: "tags",
              terms: ["javascript", "typescript"],
            }),
          ],
        },
        skipWrite: true,
      });

      const errors = warnings.filter((w) => w.includes("taxonomy term"));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes("python"))).toBe(true);
      expect(errors.some((e) => e.includes("rust"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("reports errors for duplicate taxonomy names", async () => {
    await setupProject([
      {
        path: "content/posts/hello.md",
        frontmatter: { title: "Hello" },
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
              schema: z.object({ title: z.string() }),
            },
          ],
          taxonomies: [
            defineTaxonomy({ name: "status", terms: ["draft"] }),
            defineTaxonomy({ name: "status", terms: ["published"] }),
          ],
        },
        skipWrite: true,
      });

      const errors = warnings.filter((w) => w.includes("Duplicate taxonomy"));
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("reports errors for taxonomy/collection name conflicts", async () => {
    await setupProject([
      {
        path: "content/posts/hello.md",
        frontmatter: { title: "Hello" },
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
              schema: z.object({ title: z.string() }),
            },
          ],
          taxonomies: [defineTaxonomy({ name: "posts", terms: ["draft", "published"] })],
        },
        skipWrite: true,
      });

      const errors = warnings.filter((w) => w.includes("conflicts with collection"));
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("reports errors for empty taxonomies", async () => {
    await setupProject([
      {
        path: "content/posts/hello.md",
        frontmatter: { title: "Hello" },
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
              schema: z.object({ title: z.string() }),
            },
          ],
          taxonomies: [defineTaxonomy({ name: "empty", terms: [] })],
        },
        skipWrite: true,
      });

      const errors = warnings.filter((w) => w.includes("no terms defined"));
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("reports errors for duplicate terms within a taxonomy", async () => {
    await setupProject([
      {
        path: "content/posts/hello.md",
        frontmatter: { title: "Hello" },
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
              schema: z.object({ title: z.string() }),
            },
          ],
          taxonomies: [defineTaxonomy({ name: "status", terms: ["draft", "draft", "published"] })],
        },
        skipWrite: true,
      });

      const errors = warnings.filter((w) => w.includes("duplicate term"));
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("taxonomy type generation", () => {
  it("generates types for enum taxonomy", () => {
    const collections = [
      {
        name: "posts",
        directory: "content/posts",
        schema: z.object({ title: z.string() }),
      },
    ];
    const taxonomies = [
      defineTaxonomy({
        name: "status",
        terms: ["draft", "published", "archived"],
      }),
    ];

    const types = generateTypes(collections, taxonomies);

    expect(types).toContain("TaxonomyRegistry");
    expect(types).toContain('"status"');
    expect(types).toContain('"draft"');
    expect(types).toContain('"published"');
    expect(types).toContain('"archived"');
    expect(types).toContain("export type Status");
  });

  it("generates types for schema taxonomy", () => {
    const collections = [
      {
        name: "posts",
        directory: "content/posts",
        schema: z.object({ title: z.string() }),
      },
    ];
    const taxonomies = [
      defineTaxonomy({
        name: "tags",
        schema: z.object({ name: z.string() }),
        terms: [
          { slug: "javascript", name: "JavaScript" },
          { slug: "typescript", name: "TypeScript" },
        ],
      }),
    ];

    const types = generateTypes(collections, taxonomies);

    expect(types).toContain("TaxonomyRegistry");
    expect(types).toContain('"tags"');
    expect(types).toContain('"javascript"');
    expect(types).toContain('"typescript"');
    expect(types).toContain("export type Tags");
  });

  it("generates types for multiple taxonomies", () => {
    const collections = [
      {
        name: "posts",
        directory: "content/posts",
        schema: z.object({ title: z.string() }),
      },
    ];
    const taxonomies = [
      defineTaxonomy({ name: "status", terms: ["draft", "published"] }),
      defineTaxonomy({ name: "category", terms: ["tech", "news", "opinion"] }),
    ];

    const types = generateTypes(collections, taxonomies);

    expect(types).toContain('"status"');
    expect(types).toContain('"category"');
    expect(types).toContain("export type Status");
    expect(types).toContain("export type Category");
  });

  it("handles no taxonomies", () => {
    const collections = [
      {
        name: "posts",
        directory: "content/posts",
        schema: z.object({ title: z.string() }),
      },
    ];

    const types = generateTypes(collections, []);

    expect(types).toContain("CollectionRegistry");
    expect(types).not.toContain("TaxonomyRegistry");
  });
});
