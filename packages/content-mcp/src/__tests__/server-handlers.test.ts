import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createEngine, type AnyCollection, type ResolvedConfig } from "@keel/content-core/build";
import { createTempDir, type TempDirContext } from "./test-utils";
import { handleCreateEntry, handleUpdateEntry } from "../server";

/**
 * Branch-level coverage for the standalone write handlers: absolute-directory
 * configs, async Standard-Schema validators, nested validation-issue paths,
 * write failures, and the content-default branch on update.
 */

// Build a collection list from name/dir/schema triples. The schema is widened
// to the engine's collection schema; some tests pass hand-rolled Standard
// Schemas (non-zod) whose inferred value type is `unknown`, which the engine's
// `Record<string, unknown>`-valued CollectionSchema would otherwise reject.
function makeCollections(
  defs: Array<{ name: string; directory: string; schema: unknown }>,
): AnyCollection[] {
  return defs as unknown as AnyCollection[];
}

describe("standalone write handler branches", () => {
  let ctx: TempDirContext;
  let tempDir: string;

  beforeEach(async () => {
    ctx = await createTempDir("mcp-handlers-");
    tempDir = ctx.tempDir;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function makeConfig(collections: ResolvedConfig["collections"]): ResolvedConfig {
    return {
      configPath: null,
      cwd: tempDir,
      collections,
      taxonomies: [],
      mode: "development",
    };
  }

  it("accepts an absolute collection directory (isAbsolute branch)", async () => {
    const absDir = join(tempDir, "abs-posts");
    await mkdir(absDir, { recursive: true });
    const collections = makeCollections([
      { name: "posts", directory: absDir, schema: z.object({ title: z.string() }) },
    ]);
    const engine = createEngine({ cwd: tempDir, collections, mode: "development" });
    await engine.scan();

    const result = await handleCreateEntry(engine, makeConfig(collections), {
      collection: "posts",
      slug: "abs",
      data: { title: "Abs" },
    });

    expect(result).toContain("Successfully created");
    expect(await readFile(join(absDir, "abs.md"), "utf-8")).toContain("Abs");

    // Re-scan and update via the same absolute-directory config (covers the
    // isAbsolute branch in handleUpdateEntry too).
    await engine.scan();
    const updated = await handleUpdateEntry(engine, makeConfig(collections), {
      collection: "posts",
      slug: "abs",
      data: { title: "Abs2" },
    });
    expect(updated).toContain("Successfully updated");
    expect(await readFile(join(absDir, "abs.md"), "utf-8")).toContain("Abs2");
  });

  it("reports the nested issue path when validation fails on a sub-field", async () => {
    await mkdir(join(tempDir, "content", "posts"), { recursive: true });
    const schema = z.object({
      title: z.string(),
      meta: z.object({ slugId: z.string() }),
    });
    const collections = makeCollections([{ name: "posts", directory: "content/posts", schema }]);
    const engine = createEngine({ cwd: tempDir, collections, mode: "development" });
    await engine.scan();

    const result = await handleCreateEntry(engine, makeConfig(collections), {
      collection: "posts",
      slug: "nested",
      // meta.slugId is the wrong type -> nested path "meta.slugId".
      data: { title: "T", meta: { slugId: 5 } },
    });

    expect(result).toContain("does not match");
    expect(result).toContain("meta.slugId");
  });

  it("awaits an async Standard-Schema validator (Promise branch)", async () => {
    await mkdir(join(tempDir, "content", "posts"), { recursive: true });

    // A hand-rolled Standard Schema whose validate() returns a Promise, so the
    // `result instanceof Promise` branch is taken.
    const asyncSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value: unknown) => {
          const v = value as { title?: unknown };
          if (typeof v.title !== "string") {
            return { issues: [{ message: "title required", path: ["title"] }] };
          }
          return { value };
        },
      },
    } as unknown as z.ZodType;

    const collections = makeCollections([
      { name: "posts", directory: "content/posts", schema: asyncSchema },
    ]);
    const engine = createEngine({ cwd: tempDir, collections, mode: "development" });
    await engine.scan();

    const bad = await handleCreateEntry(engine, makeConfig(collections), {
      collection: "posts",
      slug: "async-bad",
      data: {},
    });
    expect(bad).toContain("does not match");

    const good = await handleCreateEntry(engine, makeConfig(collections), {
      collection: "posts",
      slug: "async-good",
      data: { title: "ok" },
    });
    expect(good).toContain("Successfully created");
  });

  it("falls back to a 'root' issue path when a validation issue has no path", async () => {
    await mkdir(join(tempDir, "content", "posts"), { recursive: true });
    const rootIssueSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (_value: unknown) => ({ issues: [{ message: "whole object is wrong" }] }),
      },
    } as unknown as z.ZodType;

    const collections = makeCollections([
      { name: "posts", directory: "content/posts", schema: rootIssueSchema },
    ]);
    const engine = createEngine({ cwd: tempDir, collections, mode: "development" });
    await engine.scan();

    const result = await handleCreateEntry(engine, makeConfig(collections), {
      collection: "posts",
      slug: "rooted",
      data: { anything: true },
    });
    expect(result).toContain("root: whole object is wrong");
  });

  it("returns a write error from update when the file cannot be written", async () => {
    const dir = join(tempDir, "content", "posts");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "locked.md");
    await writeFile(filePath, `---\ntitle: "Locked"\n---\n\nBody.`);

    const collections = makeCollections([
      { name: "posts", directory: "content/posts", schema: z.object({ title: z.string() }) },
    ]);
    const engine = createEngine({ cwd: tempDir, collections, mode: "development" });
    await engine.scan();

    // Make the file read-only so writeFile rejects.
    await chmod(filePath, 0o444);
    try {
      const result = await handleUpdateEntry(engine, makeConfig(collections), {
        collection: "posts",
        slug: "locked",
        data: { title: "New" },
      });
      expect(result).toContain("Error writing file");
    } finally {
      await chmod(filePath, 0o644);
    }
  });

  it("handles entries that have no markdown body (empty-content branches)", async () => {
    const dir = join(tempDir, "content", "posts");
    await mkdir(dir, { recursive: true });
    // Frontmatter only, no body -> entry content is empty/undefined.
    await writeFile(join(dir, "bare.md"), `---\ntitle: "Bare"\n---\n`);

    const collections = makeCollections([
      { name: "posts", directory: "content/posts", schema: z.object({ title: z.string() }) },
    ]);
    const engine = createEngine({ cwd: tempDir, collections, mode: "development" });
    await engine.scan();

    // A data-only update on a body-less entry exercises the `?? ""` default.
    const result = await handleUpdateEntry(engine, makeConfig(collections), {
      collection: "posts",
      slug: "bare",
      data: { title: "Barer" },
    });
    expect(result).toContain("Successfully updated");
    const written = await readFile(join(dir, "bare.md"), "utf-8");
    expect(written).toContain("Barer");
  });

  it("renders an object-form issue path segment", async () => {
    await mkdir(join(tempDir, "content", "posts"), { recursive: true });
    // Standard Schema spec allows path segments to be { key } objects.
    const objectPathSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (_value: unknown) => ({
          issues: [{ message: "bad nested", path: [{ key: "outer" }, { key: "inner" }] }],
        }),
      },
    } as unknown as z.ZodType;

    const collections = makeCollections([
      { name: "posts", directory: "content/posts", schema: objectPathSchema },
    ]);
    const engine = createEngine({ cwd: tempDir, collections, mode: "development" });
    await engine.scan();

    const result = await handleCreateEntry(engine, makeConfig(collections), {
      collection: "posts",
      slug: "objpath",
      data: {},
    });
    expect(result).toContain("outer.inner: bad nested");
  });

  it("preserves existing content on a data-only update (content-default branch)", async () => {
    const dir = join(tempDir, "content", "posts");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "keep.md"), `---\ntitle: "Keep"\n---\n\nOriginal body.`);

    const collections = makeCollections([
      { name: "posts", directory: "content/posts", schema: z.object({ title: z.string() }) },
    ]);
    const engine = createEngine({ cwd: tempDir, collections, mode: "development" });
    await engine.scan();

    const result = await handleUpdateEntry(engine, makeConfig(collections), {
      collection: "posts",
      slug: "keep",
      data: { title: "Kept" },
    });
    expect(result).toContain("Successfully updated");
    const written = await readFile(join(dir, "keep.md"), "utf-8");
    expect(written).toContain("Original body");
    expect(written).toContain("Kept");
  });
});
