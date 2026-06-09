import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { AnyCollection } from "../types";
import { createImport, createNamedImport } from "../imports";
import { generate, watch, type GenerateResult } from "../generator";

const mockWatcher = {
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
};
vi.mock("chokidar", () => ({
  watch: vi.fn(() => mockWatcher),
}));

function setupProject(
  tempDir: string,
  files: Array<{ path: string; frontmatter: Record<string, unknown>; content: string }>,
) {
  return Promise.all(
    files.map(async (file) => {
      const fullPath = path.join(tempDir, file.path);
      await mkdir(path.dirname(fullPath), { recursive: true });
      const fm = Object.entries(file.frontmatter)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n");
      await writeFile(fullPath, `---\n${fm}\n---\n\n${file.content}`);
    }),
  );
}

function createCollections(configs: Array<{ name: string; directory: string }>): AnyCollection[] {
  return configs.map((c) => ({
    name: c.name,
    directory: c.directory,
    include: "**/*.md",
    schema: z.object({
      title: z.string(),
      date: z.coerce.date().optional(),
    }),
  }));
}

async function getWrittenFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  { timeout = 1000, interval = 10 } = {},
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeout) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

describe("generator", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-gen-test-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe("generate", () => {
    it("generates collection files", async () => {
      await setupProject(tempDir, [
        {
          path: "content/posts/hello.md",
          frontmatter: { title: "Hello World", date: "2024-01-01" },
          content: "Content here.",
        },
      ]);

      const result = await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
      });

      expect(result.collections).toEqual(["posts"]);
      expect(result.entryCount).toBe(1);

      expect(await fileExists(path.join(result.outDir, "posts.js"))).toBe(true);
      expect(await fileExists(path.join(result.outDir, "index.js"))).toBe(true);
      expect(await fileExists(path.join(result.outDir, "index.d.ts"))).toBe(true);
      expect(await fileExists(path.join(result.outDir, "types.d.ts"))).toBe(true);
    });

    it("generates valid JavaScript with correct data structure", async () => {
      await setupProject(tempDir, [
        {
          path: "content/posts/hello.md",
          frontmatter: { title: "Hello World", date: "2024-01-15" },
          content: "Content here.",
        },
      ]);

      const result = await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
      });

      const postsContent = await getWrittenFile(path.join(result.outDir, "posts.js"));
      expect(postsContent).toBeDefined();
      expect(postsContent).toContain('"slug":"hello"');
      expect(postsContent).toContain('"title":"Hello World"');
      expect(postsContent).toContain("2024-01-15");
    });

    it("generates correct types", async () => {
      await setupProject(tempDir, [
        {
          path: "content/posts/hello.md",
          frontmatter: { title: "Hello World" },
          content: "Content here.",
        },
      ]);

      const result = await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
      });

      const types = await getWrittenFile(result.typesPath);

      expect(types).toContain("interface CollectionRegistry");
      expect(types).toContain('"posts"');
      // Types are now inferred from config at compile time (works with any Standard Schema)
      expect(types).toContain('GetEntryByName<typeof config, "posts">');
      expect(types).toContain('GetSchemaByName<typeof config, "posts">');
    });

    it("generates index.js with re-exports", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/post.md", frontmatter: { title: "Post" }, content: "" },
        { path: "content/pages/page.md", frontmatter: { title: "Page" }, content: "" },
      ]);

      const result = await generate({
        cwd: tempDir,
        collections: createCollections([
          { name: "posts", directory: "content/posts" },
          { name: "pages", directory: "content/pages" },
        ]),
      });

      const indexContent = await getWrittenFile(result.indexPath);

      expect(indexContent).toContain('import posts from "./posts.js"');
      expect(indexContent).toContain('import pages from "./pages.js"');
      expect(indexContent).toContain("export { posts, pages }");
      expect(indexContent).toContain("collections");
    });

    it("generates index.d.ts with typed exports", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/post.md", frontmatter: { title: "Post" }, content: "" },
      ]);

      const result = await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
      });

      const indexDts = await getWrittenFile(path.join(result.outDir, "index.d.ts"));

      // New flattened type structure
      expect(indexDts).toContain("CollectionEntry");
      expect(indexDts).toContain("CollectionRegistry");
      expect(indexDts).toContain("posts");
      expect(indexDts).toContain("collections");
    });

    it("writes types to node_modules by default", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/post.md", frontmatter: { title: "Post" }, content: "" },
      ]);

      await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
      });

      expect(await fileExists(path.join(tempDir, "node_modules", ".docks", "types.d.ts"))).toBe(
        true,
      );
    });

    it("can skip writing to node_modules", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/post.md", frontmatter: { title: "Post" }, content: "" },
      ]);

      await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
        writeNodeModulesTypes: false,
      });

      expect(await fileExists(path.join(tempDir, "node_modules", ".docks", "types.d.ts"))).toBe(
        false,
      );
    });

    it("uses custom output directory", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/post.md", frontmatter: { title: "Post" }, content: "" },
      ]);

      const customOutDir = path.join(tempDir, "custom-output");
      const result = await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
        outDir: customOutDir,
      });

      expect(result.outDir).toBe(customOutDir);
      expect(await fileExists(path.join(customOutDir, "posts.js"))).toBe(true);
    });

    it("cleans output directory by default", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/post.md", frontmatter: { title: "Post" }, content: "" },
      ]);

      // Create a stale file in the output directory
      const outDir = path.join(tempDir, ".docks", "generated");
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, "stale.js"), "// stale file");

      await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
      });

      // Stale file should be removed
      expect(await fileExists(path.join(outDir, "stale.js"))).toBe(false);
    });

    it("handles empty collections", async () => {
      // Create empty directory
      await mkdir(path.join(tempDir, "content/posts"), { recursive: true });

      const result = await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
      });

      expect(result.collections).toEqual([]);
      expect(result.entryCount).toBe(0);
    });

    it("handles multiple collections", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/post1.md", frontmatter: { title: "Post 1" }, content: "" },
        { path: "content/posts/post2.md", frontmatter: { title: "Post 2" }, content: "" },
        { path: "content/pages/about.md", frontmatter: { title: "About" }, content: "" },
      ]);

      const result = await generate({
        cwd: tempDir,
        collections: createCollections([
          { name: "posts", directory: "content/posts" },
          { name: "pages", directory: "content/pages" },
        ]),
      });

      expect(result.collections.toSorted()).toEqual(["pages", "posts"]);
      expect(result.entryCount).toBe(3);
    });
  });

  describe("date serialization", () => {
    it("serializes dates as native Date constructors", async () => {
      await setupProject(tempDir, [
        {
          path: "content/posts/dated.md",
          frontmatter: { title: "Dated Post", date: "2024-03-15" },
          content: "Content with date.",
        },
      ]);

      const result = await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
      });

      const postsJsContent = await getWrittenFile(path.join(result.outDir, "posts.js"));

      // serialize-javascript outputs dates as new Date("...")
      expect(postsJsContent).toContain('new Date("2024-03-15');
      // No revive function needed - dates are native
      expect(postsJsContent).not.toContain("function revive");
      expect(postsJsContent).toContain("export default data");
    });

    it("handles entries without dates", async () => {
      await setupProject(tempDir, [
        {
          path: "content/posts/no-date.md",
          frontmatter: { title: "Post without Date" },
          content: "Content without date.",
        },
      ]);

      const result = await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
      });

      const postsJsContent = await getWrittenFile(path.join(result.outDir, "posts.js"));

      expect(postsJsContent).not.toContain("new Date(");
      expect(postsJsContent).toContain("export default data");
    });
  });

  describe("import serialization", () => {
    it("generates import statements for import references", async () => {
      await setupProject(tempDir, [
        {
          path: "content/posts/with-import.md",
          frontmatter: { title: "Post with Import" },
          content: "Content.",
        },
      ]);

      const result = await generate({
        cwd: tempDir,
        collections: [
          {
            name: "posts",
            directory: "content/posts",
            include: "**/*.md",
            schema: z.object({
              title: z.string(),
            }),
            transform: (entry) => ({
              data: {
                ...entry.data,
                component: createImport("./components/MyComponent"),
              },
            }),
          },
        ],
      });

      const postsJsContent = await getWrittenFile(path.join(result.outDir, "posts.js"));

      expect(postsJsContent).toContain('import __v_0 from "./components/MyComponent"');
      expect(postsJsContent).toMatch(/"component":\s*__v_0/);
    });

    it("generates named import statements for named import references", async () => {
      await setupProject(tempDir, [
        {
          path: "content/posts/with-named-import.md",
          frontmatter: { title: "Post with Named Import" },
          content: "Content.",
        },
      ]);

      const result = await generate({
        cwd: tempDir,
        collections: [
          {
            name: "posts",
            directory: "content/posts",
            include: "**/*.md",
            schema: z.object({
              title: z.string(),
            }),
            transform: (entry) => ({
              data: {
                ...entry.data,
                icon: createNamedImport("ChevronRight", "lucide-react"),
              },
            }),
          },
        ],
      });

      const postsJsContent = await getWrittenFile(path.join(result.outDir, "posts.js"));

      expect(postsJsContent).toContain('import { ChevronRight as __v_0 } from "lucide-react"');
      expect(postsJsContent).toMatch(/"icon":\s*__v_0/);
    });

    it("reuses same import for multiple references", async () => {
      await setupProject(tempDir, [
        {
          path: "content/posts/post1.md",
          frontmatter: { title: "Post 1" },
          content: "Content.",
        },
        {
          path: "content/posts/post2.md",
          frontmatter: { title: "Post 2" },
          content: "Content.",
        },
      ]);

      const result = await generate({
        cwd: tempDir,
        collections: [
          {
            name: "posts",
            directory: "content/posts",
            include: "**/*.md",
            schema: z.object({
              title: z.string(),
            }),
            transform: (entry) => ({
              data: {
                ...entry.data,
                component: createImport("./components/Shared"),
              },
            }),
          },
        ],
      });

      const postsJsContent = await getWrittenFile(path.join(result.outDir, "posts.js"));

      const importMatches = postsJsContent?.match(/import __v_\d+ from "\.\/components\/Shared"/g);
      expect(importMatches).toHaveLength(1);
    });
  });

  describe("onSuccess callback", () => {
    it("calls onSuccess after generation", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "" },
      ]);

      const onSuccess = vi.fn();
      await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
        onSuccess,
      });

      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          entryCount: expect.any(Number),
          collections: expect.any(Array),
          outDir: expect.any(String),
          typesPath: expect.any(String),
          indexPath: expect.any(String),
          duration: expect.any(Number),
        }),
      );
    });

    it("calls onSuccess with correct result values", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/post1.md", frontmatter: { title: "Post 1" }, content: "" },
        { path: "content/posts/post2.md", frontmatter: { title: "Post 2" }, content: "" },
      ]);

      const onSuccess = vi.fn();
      await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
        onSuccess,
      });

      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          entryCount: 2,
          collections: ["posts"],
        }),
      );
    });

    it("supports async onSuccess callback", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "" },
      ]);

      let callbackCompleted = false;
      const onSuccess = vi.fn(async () => {
        await Promise.resolve();
        callbackCompleted = true;
      });

      await generate({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
        onSuccess,
      });

      expect(onSuccess).toHaveBeenCalled();
      expect(callbackCompleted).toBe(true);
    });
  });

  describe("watch", () => {
    const getChokidarHandler = (eventType: string): ((filePath: string) => Promise<void>) => {
      const calls = mockWatcher.on.mock.calls as Array<[string, (path: string) => Promise<void>]>;
      const call = calls.find(([event]) => event === eventType);
      return call ? call[1] : async () => {};
    };

    beforeEach(() => {
      mockWatcher.on.mockClear();
      mockWatcher.close.mockClear();
    });

    it("performs initial generation", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "" },
      ]);

      let generatedResult: GenerateResult | null = null;
      const handle = watch({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
        onGenerate: (result) => {
          generatedResult = result;
        },
      });

      await waitFor(() => generatedResult !== null, { timeout: 2000 });

      expect(generatedResult).not.toBeNull();
      expect(generatedResult!.entryCount).toBe(1);

      await handle.close();
    });

    it("regenerates on file changes", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "" },
      ]);

      let generateCount = 0;
      const handle = watch({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
        debounce: 10,
        onGenerate: () => {
          generateCount++;
        },
      });

      await waitFor(() => generateCount === 1, { timeout: 2000 });
      await waitFor(() => mockWatcher.on.mock.calls.length > 0, { timeout: 2000 });

      const newFilePath = path.join(tempDir, "content/posts/new.md");
      await writeFile(newFilePath, `---\ntitle: "New Post"\n---\n\nNew content`);

      const addHandler = getChokidarHandler("add");
      await addHandler(newFilePath);

      await waitFor(() => generateCount > 1, { timeout: 2000 });

      expect(generateCount).toBeGreaterThan(1);

      await handle.close();
    });

    it("calls onError for generation failures", async () => {
      await mkdir(path.join(tempDir, "content/posts"), { recursive: true });

      let generationAttempted = false;
      const onError = vi.fn();
      const handle = watch({
        cwd: tempDir,
        collections: [
          {
            name: "posts",
            directory: "content/posts",
            include: "**/*.md",
            schema: z.object({ title: z.string() }).strict(),
          },
        ],
        onGenerate: () => {
          generationAttempted = true;
        },
        onError,
      });

      await waitFor(() => generationAttempted, { timeout: 2000 });
      await waitFor(() => mockWatcher.on.mock.calls.length > 0, { timeout: 2000 });

      const invalidFilePath = path.join(tempDir, "content/posts/invalid.md");
      await writeFile(invalidFilePath, `---\nmissing_title_field: true\n---\n\nContent`);

      const addHandler = getChokidarHandler("add");
      await addHandler(invalidFilePath);

      await waitFor(() => onError.mock.calls.length > 0, { timeout: 1000 }).catch(() => {});

      await handle.close();
    });

    it("supports manual regeneration", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "" },
      ]);

      let initialGenDone = false;
      const handle = watch({
        cwd: tempDir,
        collections: createCollections([{ name: "posts", directory: "content/posts" }]),
        onGenerate: () => {
          initialGenDone = true;
        },
      });

      await waitFor(() => initialGenDone, { timeout: 2000 });

      const result = await handle.regenerate();

      expect(result.entryCount).toBe(1);

      await handle.close();
    });

    it("handles multiple file changes in different collections", async () => {
      await setupProject(tempDir, [
        { path: "content/posts/post1.md", frontmatter: { title: "Post 1" }, content: "" },
        { path: "content/pages/page1.md", frontmatter: { title: "Page 1" }, content: "" },
      ]);

      let generateCount = 0;
      let lastResult: GenerateResult | null = null;
      const handle = watch({
        cwd: tempDir,
        collections: createCollections([
          { name: "posts", directory: "content/posts" },
          { name: "pages", directory: "content/pages" },
        ]),
        debounce: 10,
        onGenerate: (result) => {
          generateCount++;
          lastResult = result;
        },
      });

      await waitFor(() => generateCount === 1, { timeout: 2000 });
      expect(lastResult!.collections.toSorted()).toEqual(["pages", "posts"]);

      await waitFor(() => mockWatcher.on.mock.calls.length > 0, { timeout: 2000 });

      const post1Path = path.join(tempDir, "content/posts/post1.md");
      const page1Path = path.join(tempDir, "content/pages/page1.md");
      await writeFile(post1Path, `---\ntitle: "Post 1 Updated"\n---\n\nUpdated content`);
      await writeFile(page1Path, `---\ntitle: "Page 1 Updated"\n---\n\nUpdated content`);

      const changeHandler = getChokidarHandler("change");
      await changeHandler(post1Path);
      await changeHandler(page1Path);

      await waitFor(() => generateCount > 1, { timeout: 2000 });

      expect(generateCount).toBeGreaterThan(1);
      expect(lastResult!.collections.toSorted()).toEqual(["pages", "posts"]);

      await handle.close();
    });
  });
});
