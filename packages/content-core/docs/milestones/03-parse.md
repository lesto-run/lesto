# Milestone 3: Pipeline - Parse

## Objective
Implement the parsing stage with frontmatter extraction and schema validation.

## Dependencies
- Milestone 1 (types)
- Milestone 2 (collector)

## Deliverables
- [ ] `parser.ts` - Parse with schema validation
- [ ] Tests for parsing and validation

## Files to Create/Modify

### `packages/core/src/parser.ts` (Rewrite)

```typescript
import { readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { CollectedFile } from "./collector";
import type { Document, DocumentMeta, CollectionSchema } from "./types";
import { ValidationError } from "./types";

export interface ParsedDocument {
  /** Source file info */
  file: CollectedFile;

  /** Parsed document */
  document: Document;

  /** Derived URL slug */
  slug: string;
}

export interface ParseResult {
  /** Successfully parsed documents */
  documents: ParsedDocument[];

  /** Validation errors (for reporting) */
  errors: ValidationError[];
}

/**
 * Build document metadata from relative path.
 */
function buildMeta(relativePath: string): DocumentMeta {
  const parsed = path.parse(relativePath);
  return {
    path: relativePath,
    fileName: parsed.name,
    extension: parsed.ext.slice(1), // Remove leading dot
    directory: parsed.dir || ".",
  };
}

/**
 * Derive URL-friendly slug from file path.
 */
function deriveSlug(relativePath: string): string {
  const parsed = path.parse(relativePath);

  // index.md files use parent directory name
  if (parsed.name === "index") {
    const dir = parsed.dir;
    if (!dir || dir === ".") return "index";
    return dir.split(path.sep).pop()!;
  }

  // Remove extension, preserve nested structure
  return relativePath.replace(/\.[^.]+$/, "").split(path.sep).join("/");
}

/**
 * Validate data against Standard Schema.
 */
async function validateSchema(
  schema: CollectionSchema,
  data: unknown,
  filePath: string,
  collection: string
): Promise<Record<string, unknown>> {
  // Standard Schema validation
  const result = schema["~standard"].validate(data);
  const resolved = result instanceof Promise ? await result : result;

  if (resolved.issues) {
    throw new ValidationError(
      resolved.issues.map((issue) => ({
        message: issue.message,
        path: issue.path as PropertyKey[] | undefined,
      })),
      filePath,
      collection
    );
  }

  return resolved.value as Record<string, unknown>;
}

/**
 * Parse a single file.
 */
async function parseFile(file: CollectedFile): Promise<ParsedDocument> {
  const content = await readFile(file.absolutePath, "utf-8");
  const { data: rawData, content: body } = matter(content);

  // Validate against schema
  const data = await validateSchema(
    file.collection.schema,
    rawData,
    file.absolutePath,
    file.collection.name
  );

  const meta = buildMeta(file.relativePath);
  const slug = deriveSlug(file.relativePath);

  return {
    file,
    document: {
      data,
      content: body,
      _meta: meta,
    },
    slug,
  };
}

/**
 * Parse multiple files in parallel.
 */
export async function parse(files: CollectedFile[]): Promise<ParseResult> {
  const results = await Promise.allSettled(files.map(parseFile));

  const documents: ParsedDocument[] = [];
  const errors: ValidationError[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      documents.push(result.value);
    } else {
      if (result.reason instanceof ValidationError) {
        errors.push(result.reason);
      } else {
        // Re-throw unexpected errors
        throw result.reason;
      }
    }
  }

  return { documents, errors };
}

/**
 * Parse a single file (useful for watch mode).
 */
export async function parseOne(file: CollectedFile): Promise<ParsedDocument> {
  return parseFile(file);
}
```

## Tests

### `packages/core/src/__tests__/parser.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse, parseOne } from "../parser";
import { ValidationError } from "../types";
import { z } from "zod";

describe("parser", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docks-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const createFile = async (
    relativePath: string,
    frontmatter: Record<string, unknown>,
    content: string
  ) => {
    const fullPath = path.join(tempDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });

    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");

    await writeFile(fullPath, `---\n${fm}\n---\n\n${content}`);
    return fullPath;
  };

  const createCollectedFile = (
    absolutePath: string,
    relativePath: string,
    schema: any = z.object({ title: z.string() })
  ) => ({
    absolutePath,
    relativePath,
    collection: {
      name: "posts",
      directory: "content/posts",
      schema,
    },
  });

  describe("parse", () => {
    it("parses frontmatter correctly", async () => {
      const filePath = await createFile("post.md", { title: "Hello" }, "Content");
      const file = createCollectedFile(filePath, "post.md");

      const { documents } = await parse([file]);

      expect(documents).toHaveLength(1);
      expect(documents[0].document.data).toEqual({ title: "Hello" });
    });

    it("extracts content without frontmatter", async () => {
      const filePath = await createFile("post.md", { title: "Hello" }, "Body content");
      const file = createCollectedFile(filePath, "post.md");

      const { documents } = await parse([file]);

      expect(documents[0].document.content.trim()).toBe("Body content");
    });

    it("validates against schema", async () => {
      const filePath = await createFile("post.md", { title: 123 }, "Content");
      const schema = z.object({ title: z.string() });
      const file = createCollectedFile(filePath, "post.md", schema);

      const { documents, errors } = await parse([file]);

      expect(documents).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(ValidationError);
    });

    it("coerces types via schema", async () => {
      const filePath = await createFile("post.md", { date: "2024-01-01" }, "Content");
      const schema = z.object({ date: z.coerce.date() });
      const file = createCollectedFile(filePath, "post.md", schema);

      const { documents } = await parse([file]);

      expect(documents[0].document.data.date).toBeInstanceOf(Date);
    });

    it("applies default values", async () => {
      const filePath = await createFile("post.md", { title: "Hello" }, "Content");
      const schema = z.object({
        title: z.string(),
        draft: z.boolean().default(false),
      });
      const file = createCollectedFile(filePath, "post.md", schema);

      const { documents } = await parse([file]);

      expect(documents[0].document.data.draft).toBe(false);
    });

    it("builds correct document meta", async () => {
      const filePath = await createFile("post.md", { title: "Hello" }, "Content");
      const file = createCollectedFile(filePath, "post.md");

      const { documents } = await parse([file]);

      expect(documents[0].document._meta).toEqual({
        path: "post.md",
        fileName: "post",
        extension: "md",
        directory: ".",
      });
    });

    it("handles nested file paths", async () => {
      const filePath = await createFile(
        path.join("2024", "01", "post.md"),
        { title: "Hello" },
        "Content"
      );
      const file = createCollectedFile(filePath, path.join("2024", "01", "post.md"));

      const { documents } = await parse([file]);

      expect(documents[0].document._meta.directory).toBe(path.join("2024", "01"));
      expect(documents[0].slug).toBe("2024/01/post");
    });
  });

  describe("slug derivation", () => {
    it("uses filename as slug", async () => {
      const filePath = await createFile("my-post.md", { title: "Hello" }, "");
      const file = createCollectedFile(filePath, "my-post.md");

      const { documents } = await parse([file]);

      expect(documents[0].slug).toBe("my-post");
    });

    it("uses parent directory for index.md", async () => {
      const filePath = await createFile("about/index.md", { title: "About" }, "");
      const file = createCollectedFile(filePath, path.join("about", "index.md"));

      const { documents } = await parse([file]);

      expect(documents[0].slug).toBe("about");
    });

    it("handles root index.md", async () => {
      const filePath = await createFile("index.md", { title: "Home" }, "");
      const file = createCollectedFile(filePath, "index.md");

      const { documents } = await parse([file]);

      expect(documents[0].slug).toBe("index");
    });
  });

  describe("error handling", () => {
    it("returns validation errors without throwing", async () => {
      const file1 = await createFile("valid.md", { title: "Valid" }, "");
      const file2 = await createFile("invalid.md", { title: 123 }, "");

      const files = [
        createCollectedFile(file1, "valid.md"),
        createCollectedFile(file2, "invalid.md"),
      ];

      const { documents, errors } = await parse(files);

      expect(documents).toHaveLength(1);
      expect(errors).toHaveLength(1);
    });

    it("validation error includes file path", async () => {
      const filePath = await createFile("invalid.md", { title: 123 }, "");
      const file = createCollectedFile(filePath, "invalid.md");

      const { errors } = await parse([file]);

      expect(errors[0].filePath).toBe(filePath);
      expect(errors[0].collection).toBe("posts");
    });

    it("validation error includes field path", async () => {
      const filePath = await createFile("invalid.md", { title: 123 }, "");
      const file = createCollectedFile(filePath, "invalid.md");

      const { errors } = await parse([file]);

      expect(errors[0].issues[0].path).toContain("title");
    });
  });
});
```

## Acceptance Criteria

- [ ] Frontmatter is correctly extracted
- [ ] Content is separated from frontmatter
- [ ] Schema validation works with Zod
- [ ] Schema coercion (z.coerce.date()) works
- [ ] Default values are applied
- [ ] Document metadata is correct
- [ ] Slugs are derived correctly (including index.md handling)
- [ ] Validation errors are collected, not thrown
- [ ] Error messages include file path and field path
- [ ] All tests pass
