import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nn } from "./test-utils";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse } from "../parser";
import type { CollectedFile } from "../collector";
import type { CollectionSchema } from "../types";
import type { ParserOption } from "@lesto/content-umbra";
import { z } from "zod";

const createCollectedFile = (
  absolutePath: string,
  relativePath: string,
  schema: CollectionSchema = z.object({ title: z.string() }),
  parser: ParserOption = "frontmatter",
): CollectedFile => ({
  absolutePath,
  relativePath,
  collection: {
    name: "posts",
    directory: "content/posts",
    schema,
    parser,
  },
});

describe("worker pool", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-workers-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const createFile = async (
    relativePath: string,
    frontmatter: Record<string, unknown>,
    content: string,
  ) => {
    const fullPath = path.join(tempDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });

    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");

    await writeFile(fullPath, `---\n${fm}\n---\n\n${content}`);
    return fullPath;
  };

  it("parses files with worker pool enabled", async () => {
    const files = await Promise.all([
      createFile("post1.md", { title: "Post 1" }, "Content 1"),
      createFile("post2.md", { title: "Post 2" }, "Content 2"),
      createFile("post3.md", { title: "Post 3" }, "Content 3"),
    ]);

    const collectedFiles = files.map((file, i) => createCollectedFile(file, `post${i + 1}.md`));

    const { documents, errors } = await parse(collectedFiles, { useWorkers: true });

    expect(errors).toHaveLength(0);
    expect(documents).toHaveLength(3);
    expect(nn(documents[0]).document.data).toEqual({ title: "Post 1" });
    expect(nn(documents[1]).document.data).toEqual({ title: "Post 2" });
    expect(nn(documents[2]).document.data).toEqual({ title: "Post 3" });
    expect(nn(documents[0]).document.content.trim()).toBe("Content 1");
  });

  it("parses files with worker pool disabled", async () => {
    const files = await Promise.all([
      createFile("post1.md", { title: "Post 1" }, "Content 1"),
      createFile("post2.md", { title: "Post 2" }, "Content 2"),
    ]);

    const collectedFiles = files.map((file, i) => createCollectedFile(file, `post${i + 1}.md`));

    const { documents, errors } = await parse(collectedFiles, { useWorkers: false });

    expect(errors).toHaveLength(0);
    expect(documents).toHaveLength(2);
    expect(nn(documents[0]).document.data).toEqual({ title: "Post 1" });
  });

  it("automatically enables workers for large file counts", async () => {
    // Use 55 files (just above 50 threshold) to reduce test time
    const files = await Promise.all(
      Array.from({ length: 55 }, (_, i) =>
        createFile(`post${i}.md`, { title: `Post ${i}` }, `Content ${i}`),
      ),
    );

    const collectedFiles = files.map((file, i) => createCollectedFile(file, `post${i}.md`));

    const { documents, errors } = await parse(collectedFiles);

    expect(errors).toHaveLength(0);
    expect(documents).toHaveLength(55);
  });

  it("handles validation errors with workers enabled", async () => {
    const filePath = await createFile("invalid.md", { title: 123 }, "Content");
    const schema = z.object({ title: z.string() });
    const file = createCollectedFile(filePath, "invalid.md", schema);

    const { documents, errors } = await parse([file], { useWorkers: true });

    expect(documents).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("supports different parser presets with workers enabled", async () => {
    const yamlPath = path.join(tempDir, "data.yaml");
    await writeFile(yamlPath, "title: YAML Test\ncount: 42");

    const jsonPath = path.join(tempDir, "data.json");
    await writeFile(jsonPath, JSON.stringify({ title: "JSON Test", count: 100 }));

    const schema = z.object({ title: z.string(), count: z.number() });

    const files = [
      createCollectedFile(yamlPath, "data.yaml", schema, "yaml"),
      createCollectedFile(jsonPath, "data.json", schema, "json"),
    ];

    const { documents, errors } = await parse(files, { useWorkers: true });

    expect(errors).toHaveLength(0);
    expect(documents).toHaveLength(2);
    expect(nn(documents[0]).document.data).toEqual({ title: "YAML Test", count: 42 });
    expect(nn(documents[1]).document.data).toEqual({ title: "JSON Test", count: 100 });
  });

  it("falls back to main thread for custom parsers", async () => {
    const filePath = await createFile("custom.md", { title: "Custom" }, "Content");
    const schema = z.object({ title: z.string() });

    const customParser = {
      name: "custom",
      extensions: ["md"],
      hasContent: true,
      parse: (_content: string) => ({
        data: { title: "Custom Parser" },
        content: "Custom Content",
      }),
    };

    const file = {
      absolutePath: filePath,
      relativePath: "custom.md",
      collection: {
        name: "posts",
        directory: "content/posts",
        schema,
        parser: customParser,
      },
    };

    const { documents, errors } = await parse([file], { useWorkers: true });

    expect(errors).toHaveLength(0);
    expect(documents).toHaveLength(1);
    expect(nn(documents[0]).document.data).toEqual({ title: "Custom Parser" });
    expect(nn(documents[0]).document.content).toBe("Custom Content");
  });
});
