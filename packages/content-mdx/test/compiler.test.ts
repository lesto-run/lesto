import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Root } from "mdast";
import type { VFile } from "vfile";

import {
  compileMDX,
  createEsbuildOptionsBuilder,
  createMdxOptionsBuilder,
  handleCompilationError,
} from "../src/compiler";
import type { Heading, MDXCompileOptions } from "../src/types";

// ---------------------------------------------------------------------------
// createMdxOptionsBuilder — assembles the remark/rehype pipeline and routes
// extracted headings to the callback.
// ---------------------------------------------------------------------------

function buildMdxOptions(remarkPlugins: unknown, rehypePlugins: unknown) {
  let captured: Heading[] = [];

  const build = createMdxOptionsBuilder(remarkPlugins, rehypePlugins, (h) => {
    captured = h;
  });

  const mdxOptions: { remarkPlugins?: unknown[]; rehypePlugins?: unknown[] } = {};

  const result = build(mdxOptions);

  return { result, getCaptured: () => captured };
}

/** Stand-in caller plugins; the tests only check pipeline placement (identity). */
const userRemark = () => undefined;
const userRehype = () => undefined;

describe("createMdxOptionsBuilder", () => {
  it("prepends remark-gfm and our extractor, then appends caller plugins", () => {
    const { result } = buildMdxOptions(userRemark, userRehype);

    // remark: [gfm, ourExtractor, ...user]
    expect(result.remarkPlugins).toHaveLength(3);
    expect(result.remarkPlugins?.[2]).toBe(userRemark);

    // rehype: [slug, [prettyCode, opts], ...user]
    expect(result.rehypePlugins).toHaveLength(3);
    expect(result.rehypePlugins?.[2]).toBe(userRehype);
  });

  it("normalizes a missing caller plugin list to no extra entries", () => {
    const { result } = buildMdxOptions(undefined, null);

    expect(result.remarkPlugins).toHaveLength(2);
    expect(result.rehypePlugins).toHaveLength(2);
  });

  it("forwards extracted headings from the injected transformer", () => {
    const { result, getCaptured } = buildMdxOptions([], []);

    // The second remark entry is our transformer factory: invoke it, then run
    // the returned transformer over a tree carrying one heading.
    const factory = result.remarkPlugins?.[1] as () => (tree: Root, file: VFile) => void;
    const transform = factory();

    const tree = {
      type: "root",
      children: [{ type: "heading", depth: 1, children: [{ type: "text", value: "Hi" }] }],
    } as unknown as Root;

    transform(tree, { data: {} } as unknown as VFile);

    expect(getCaptured()).toEqual([{ depth: 1, text: "Hi", slug: "hi" }]);
  });

  it("falls back to an empty array when the transformer recorded no headings", () => {
    const { result, getCaptured } = buildMdxOptions([], []);

    const factory = result.remarkPlugins?.[1] as () => (tree: Root, file: VFile) => void;
    const transform = factory();

    // A document with no headings leaves file.data.headings undefined -> [].
    const tree = { type: "root", children: [] } as unknown as Root;

    transform(tree, { data: {} } as unknown as VFile);

    expect(getCaptured()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createEsbuildOptionsBuilder — alias resolution + NODE_ENV define.
// ---------------------------------------------------------------------------

describe("createEsbuildOptionsBuilder", () => {
  const originalNodeEnv = process.env["NODE_ENV"];

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = originalNodeEnv;
  });

  it("resolves aliases against projectRoot in file mode", () => {
    const options: MDXCompileOptions = {
      filePath: "/docs/post.mdx",
      projectRoot: "/project",
      aliases: { "@components/*": "./src/components/*", "@lib": "./src/lib" },
    };

    const build = createEsbuildOptionsBuilder(options, true);

    const esbuild: { alias?: Record<string, string>; define?: Record<string, string> } = {};

    build(esbuild);

    expect(esbuild.alias).toEqual({
      "@components": path.resolve("/project", "./src/components"),
      "@lib": path.resolve("/project", "./src/lib"),
    });
  });

  it("skips alias resolution when not in file mode", () => {
    const options: MDXCompileOptions = { source: "# Hi" };

    const build = createEsbuildOptionsBuilder(options, false);

    const esbuild: { alias?: Record<string, string>; define?: Record<string, string> } = {};

    build(esbuild);

    expect(esbuild.alias).toBeUndefined();
  });

  it("skips alias resolution in file mode when aliases/projectRoot are absent", () => {
    const options: MDXCompileOptions = { filePath: "/docs/post.mdx" };

    const build = createEsbuildOptionsBuilder(options, true);

    const esbuild: { alias?: Record<string, string>; define?: Record<string, string> } = {};

    build(esbuild);

    expect(esbuild.alias).toBeUndefined();
  });

  it("defines NODE_ENV from the environment when set", () => {
    process.env["NODE_ENV"] = "development";

    const build = createEsbuildOptionsBuilder({ source: "x" }, false);

    const esbuild: { define?: Record<string, string> } = {};

    build(esbuild);

    expect(esbuild.define).toEqual({
      "process.env.NODE_ENV": JSON.stringify("development"),
    });
  });

  it('falls back to "production" when NODE_ENV is unset', () => {
    delete process.env["NODE_ENV"];

    const build = createEsbuildOptionsBuilder({ source: "x" }, false);

    const esbuild: { define?: Record<string, string> } = {};

    build(esbuild);

    expect(esbuild.define).toEqual({
      "process.env.NODE_ENV": JSON.stringify("production"),
    });
  });
});

// ---------------------------------------------------------------------------
// handleCompilationError — wrap Errors, rethrow non-Errors untouched.
// ---------------------------------------------------------------------------

describe("handleCompilationError", () => {
  it("wraps an Error with the location and preserves the cause", () => {
    const original = new Error("boom");

    try {
      handleCompilationError(original, "/docs/post.mdx");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("MDX compilation failed for /docs/post.mdx: boom");
      expect((error as Error).cause).toBe(original);
    }
  });

  it("rethrows a non-Error throw untouched", () => {
    const thrown = { weird: true };

    expect(() => handleCompilationError(thrown, "source")).toThrow();

    try {
      handleCompilationError(thrown, "source");
    } catch (error) {
      expect(error).toBe(thrown);
    }
  });
});

// ---------------------------------------------------------------------------
// compileMDX — real integration compiles (mdx-bundler + esbuild + remark).
// These are intentionally NOT mocked: they prove the wiring end to end.
// ---------------------------------------------------------------------------

describe("compileMDX (integration)", () => {
  it("compiles source, extracting headings, reading time, and excerpt", async () => {
    const source = [
      "# Top Heading",
      "",
      "Some introductory prose with several words to count.",
      "",
      "## Sub Heading",
      "",
      "More words here for the reading-time estimate.",
    ].join("\n");

    const result = await compileMDX({ source });

    expect(result.code.length).toBeGreaterThan(0);

    expect(result.headings).toEqual([
      { depth: 1, text: "Top Heading", slug: "top-heading" },
      { depth: 2, text: "Sub Heading", slug: "sub-heading" },
    ]);

    expect(result.readingTime.words).toBeGreaterThan(0);
    expect(result.readingTime.text).toBe("1 min read");

    // The excerpt is derived from the raw source (heading markers stripped).
    expect(result.excerpt).toContain("Top Heading");
  }, 60000);

  it("parses YAML frontmatter into the frontmatter field", async () => {
    const source = ["---", "title: Demo", "draft: true", "---", "# Body", "", "Text."].join("\n");

    const result = await compileMDX({ source });

    expect(result.frontmatter).toEqual({ title: "Demo", draft: true });
  }, 60000);

  it("compiles a file from disk, resolving cwd from the file's directory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mdx-compile-"));
    const filePath = path.join(dir, "post.mdx");

    writeFileSync(filePath, "# File Title\n\nBody text from a real file on disk.\n");

    try {
      const result = await compileMDX({ filePath });

      expect(result.headings).toEqual([{ depth: 1, text: "File Title", slug: "file-title" }]);
      expect(result.code.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("compiles source with an explicit cwd", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mdx-cwd-"));

    try {
      const result = await compileMDX({
        source: "# With Cwd\n\nResolves imports relative to the given directory.",
        cwd: dir,
      });

      expect(result.headings).toEqual([{ depth: 1, text: "With Cwd", slug: "with-cwd" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("rejects when neither filePath nor source is provided", async () => {
    await expect(compileMDX({ source: "" } as MDXCompileOptions)).rejects.toThrow(
      "Either filePath or source must be provided",
    );
  });

  it("wraps a bundler failure with the source location", async () => {
    // Unterminated JSX expression — esbuild/mdx rejects it.
    await expect(compileMDX({ source: "# Bad\n\n<Component prop={" })).rejects.toThrow(
      /MDX compilation failed for source:/,
    );
  }, 60000);

  it("wraps a bundler failure with the file location", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mdx-fail-"));
    const filePath = path.join(dir, "broken.mdx");

    writeFileSync(filePath, "# Broken\n\n<Component prop={");

    try {
      await expect(compileMDX({ filePath })).rejects.toThrow(
        new RegExp(`MDX compilation failed for ${filePath.replace(/[/\\.]/g, "\\$&")}:`),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
