import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createTempDir, type TempDirContext } from "./test-utils";
import { createEngine } from "../engine";
import { handleCreateEntry } from "../mcp";
import type { ResolvedConfig } from "../config";

/**
 * Regression coverage for create_entry's promised schema validation.
 *
 * The tool description claims it "Validates against the collection schema", but
 * the handler used to write the file with zero validation. These tests pin the
 * data-integrity expectation: data that violates the schema is rejected and NO
 * file is written; valid data succeeds.
 */
describe("handleCreateEntry schema validation", () => {
  let ctx: TempDirContext;
  let tempDir: string;

  const postsSchema = z.object({
    title: z.string(),
    publishedAt: z.coerce.date(),
  });

  beforeEach(async () => {
    ctx = await createTempDir("mcp-create-");
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
