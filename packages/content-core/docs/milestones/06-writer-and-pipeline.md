# Milestone 6: Writer & Pipeline Orchestrator

## Objective
Implement the writer stage and pipeline orchestrator that ties all stages together.

## Dependencies
- Milestones 1-5 (all pipeline stages)

## Deliverables
- [ ] `writer.ts` - Write generated types to disk
- [ ] `pipeline.ts` - Pipeline orchestrator
- [ ] Integration tests

## Files to Create

### `packages/core/src/writer.ts` (New File)

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedConfig } from "./config";
import { generateTypes } from "./typegen";

export interface WriteOptions {
  /** Output directory (default: node_modules/.docks) */
  outDir?: string;
}

export interface WriteResult {
  /** Path to generated types file */
  typesPath: string;

  /** Content that was written */
  typesContent: string;
}

/**
 * Write generated types to disk.
 */
export async function write(
  config: ResolvedConfig,
  options: WriteOptions = {}
): Promise<WriteResult> {
  const outDir = options.outDir ?? path.join(config.cwd, "node_modules", ".docks");

  // Ensure directory exists
  await mkdir(outDir, { recursive: true });

  // Generate types from schema (not data!)
  const typesContent = generateTypes(config.collections);
  const typesPath = path.join(outDir, "types.d.ts");

  await writeFile(typesPath, typesContent, "utf-8");

  return { typesPath, typesContent };
}
```

### `packages/core/src/pipeline.ts` (New File)

```typescript
import { resolveConfig, type ResolvedConfig } from "./config";
import { collect, type CollectedFile } from "./collector";
import { parse, type ParseResult } from "./parser";
import { transform, type TransformResult } from "./transformer";
import { write, type WriteResult } from "./writer";
import type { Entry, EngineConfig } from "./types";

// =============================================================================
// Pipeline Types
// =============================================================================

export interface PipelineResult {
  /** Resolved configuration */
  config: ResolvedConfig;

  /** Collected files */
  files: CollectedFile[];

  /** Parse result */
  parseResult: ParseResult;

  /** Transform result */
  transformResult: TransformResult;

  /** Write result */
  writeResult: WriteResult;

  /** Final entries (convenience) */
  entries: Entry[];
}

export interface PipelineOptions {
  /** Working directory (default: process.cwd()) */
  cwd?: string;

  /** Programmatic config (bypasses file loading) */
  config?: EngineConfig;

  /** Output directory for types */
  outDir?: string;

  /** Skip writing files */
  skipWrite?: boolean;
}

// =============================================================================
// Pipeline Execution
// =============================================================================

/**
 * Run the full pipeline: config → collect → parse → transform → write
 */
export async function runPipeline(options: PipelineOptions = {}): Promise<PipelineResult> {
  const cwd = options.cwd ?? process.cwd();

  // Stage 1: Config
  const config = await resolveConfig(cwd, options.config);

  // Stage 2: Collect
  const files = await collect(config);

  // Stage 3: Parse
  const parseResult = await parse(files);

  // Report validation errors
  if (parseResult.errors.length > 0) {
    for (const error of parseResult.errors) {
      if (config.onValidationWarning) {
        config.onValidationWarning(error);
      } else {
        console.warn(`[docks] ${error.message}`);
      }
    }
  }

  // Stage 4: Transform
  const transformResult = await transform(parseResult.documents, config);

  // Report transform errors
  if (transformResult.errors.length > 0) {
    for (const error of transformResult.errors) {
      if (config.onTransformError) {
        config.onTransformError(error);
      } else {
        console.warn(`[docks] ${error.message}`);
      }
    }
  }

  // Stage 5: Write
  const writeResult = options.skipWrite
    ? { typesPath: "", typesContent: "" }
    : await write(config, { outDir: options.outDir });

  return {
    config,
    files,
    parseResult,
    transformResult,
    writeResult,
    entries: transformResult.entries,
  };
}

/**
 * Export individual stages for advanced use cases.
 */
export const pipeline = {
  config: resolveConfig,
  collect,
  parse,
  transform,
  write,
  run: runPipeline,
};
```

## Tests

### `packages/core/src/__tests__/pipeline.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runPipeline, pipeline } from "../pipeline";
import { z } from "zod";

describe("pipeline", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docks-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const setupProject = async (
    collections: any[],
    files: Array<{ path: string; frontmatter: Record<string, unknown>; content: string }>
  ) => {
    // Create config
    const configContent = `
      import { z } from "zod";
      export default {
        collections: ${JSON.stringify(collections).replace(/"schema":\s*{[^}]*}/g, (match) => {
          return match; // Keep schema as-is for now
        })}
      };
    `;

    // For testing, we'll use programmatic config
    // Create content files
    for (const file of files) {
      const fullPath = path.join(tempDir, file.path);
      await mkdir(path.dirname(fullPath), { recursive: true });
      const fm = Object.entries(file.frontmatter)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n");
      await writeFile(fullPath, `---\n${fm}\n---\n\n${file.content}`);
    }
  };

  describe("runPipeline", () => {
    it("runs full pipeline with programmatic config", async () => {
      await setupProject([], [
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "World" },
      ]);

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [{
            name: "posts",
            directory: "content/posts",
            schema: z.object({ title: z.string() }),
          }],
        },
        skipWrite: true,
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].slug).toBe("hello");
      expect(result.entries[0].data.title).toBe("Hello");
    });

    it("collects files from multiple collections", async () => {
      await setupProject([], [
        { path: "content/posts/post.md", frontmatter: { title: "Post" }, content: "" },
        { path: "content/pages/page.md", frontmatter: { title: "Page" }, content: "" },
      ]);

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [
            { name: "posts", directory: "content/posts", schema: z.object({ title: z.string() }) },
            { name: "pages", directory: "content/pages", schema: z.object({ title: z.string() }) },
          ],
        },
        skipWrite: true,
      });

      expect(result.entries).toHaveLength(2);
      expect(result.files).toHaveLength(2);
    });

    it("applies transforms", async () => {
      await setupProject([], [
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "one two three" },
      ]);

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [{
            name: "posts",
            directory: "content/posts",
            schema: z.object({ title: z.string() }),
            transform: (doc: any) => ({ wordCount: doc.content.trim().split(/\s+/).length }),
          }],
        },
        skipWrite: true,
      });

      expect(result.entries[0].transformed).toEqual({ wordCount: 3 });
    });

    it("writes types file", async () => {
      await setupProject([], [
        { path: "content/posts/hello.md", frontmatter: { title: "Hello" }, content: "" },
      ]);

      const outDir = path.join(tempDir, ".docks");
      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [{
            name: "posts",
            directory: "content/posts",
            schema: z.object({ title: z.string() }),
          }],
        },
        outDir,
      });

      expect(result.writeResult.typesPath).toContain("types.d.ts");

      const content = await readFile(result.writeResult.typesPath, "utf-8");
      expect(content).toContain("CollectionRegistry");
      expect(content).toContain('"posts"');
    });

    it("collects validation errors", async () => {
      await setupProject([], [
        { path: "content/posts/valid.md", frontmatter: { title: "Valid" }, content: "" },
        { path: "content/posts/invalid.md", frontmatter: { title: 123 }, content: "" },
      ]);

      const warnings: any[] = [];
      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [{
            name: "posts",
            directory: "content/posts",
            schema: z.object({ title: z.string() }),
          }],
          onValidationWarning: (err) => warnings.push(err),
        },
        skipWrite: true,
      });

      expect(result.entries).toHaveLength(1);
      expect(warnings).toHaveLength(1);
    });

    it("reports skipped documents", async () => {
      await setupProject([], [
        { path: "content/posts/skip.md", frontmatter: { title: "Skip" }, content: "" },
      ]);

      const result = await runPipeline({
        cwd: tempDir,
        config: {
          collections: [{
            name: "posts",
            directory: "content/posts",
            schema: z.object({ title: z.string() }),
            transform: (_: any, ctx: any) => ctx.skip(),
          }],
        },
        skipWrite: true,
      });

      expect(result.entries).toHaveLength(0);
      expect(result.transformResult.skipped).toHaveLength(1);
    });
  });

  describe("pipeline exports", () => {
    it("exports individual stages", () => {
      expect(typeof pipeline.config).toBe("function");
      expect(typeof pipeline.collect).toBe("function");
      expect(typeof pipeline.parse).toBe("function");
      expect(typeof pipeline.transform).toBe("function");
      expect(typeof pipeline.write).toBe("function");
      expect(typeof pipeline.run).toBe("function");
    });
  });
});
```

## Acceptance Criteria

- [ ] Writer creates output directory
- [ ] Writer generates types.d.ts
- [ ] Pipeline runs all stages in order
- [ ] Pipeline handles validation errors
- [ ] Pipeline handles transform errors
- [ ] Pipeline reports skipped documents
- [ ] Programmatic config works
- [ ] Individual stages are exported
- [ ] All tests pass
