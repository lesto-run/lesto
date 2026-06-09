import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createTempDir, type TempDirContext } from "./test-utils";
import { createEngine } from "../engine";
import { handleUpdateEntry } from "../mcp";
import type { ResolvedConfig } from "../config";

/**
 * Regression coverage for update_entry leaking engine metadata into frontmatter.
 *
 * A RuntimeEntry carries EntryMeta fields ("id", "collection", "file") as
 * own-enumerable keys alongside the author's frontmatter. None of those are
 * "_"-prefixed, so the original "skip underscore + content/slug/rendered"
 * filter copied them straight back into the persisted YAML — including the
 * entire `file` DocumentMeta object. update_entry must strip them.
 */
describe("handleUpdateEntry frontmatter hygiene", () => {
  let ctx: TempDirContext;
  let tempDir: string;

  const postsSchema = z.object({
    title: z.string(),
    publishedAt: z.coerce.date(),
    draft: z.boolean().optional(),
  });

  beforeEach(async () => {
    ctx = await createTempDir("mcp-update-");
    tempDir = ctx.tempDir;
    await mkdir(join(tempDir, "content", "posts"), { recursive: true });
    await writeFile(
      join(tempDir, "content", "posts", "hello-world.md"),
      `---\ntitle: "Hello World"\npublishedAt: 2024-01-15\ndraft: false\n---\n\nBody.`,
    );
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

  it("does not persist engine-internal id/collection/file into frontmatter", async () => {
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
});
