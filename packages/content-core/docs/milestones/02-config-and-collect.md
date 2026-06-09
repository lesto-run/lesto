# Milestone 2: Pipeline - Config & Collect

## Objective
Implement the first two pipeline stages: configuration loading and file collection.

## Dependencies
- Milestone 1 (types.ts, context.ts)

## Deliverables
- [ ] `config.ts` - Enhanced config resolution
- [ ] `collector.ts` - File collection with glob patterns
- [ ] Tests for both stages

## Files to Create/Modify

### 1. `packages/core/src/config.ts` (Enhance)

```typescript
import { access } from "node:fs/promises";
import path from "node:path";
import type { AnyCollection, EngineConfig, ValidationMode } from "./types";

export const CONFIG_FILE_NAMES = [
  "docks.config.ts",
  "docks.config.js",
  "docks.config.mjs",
] as const;

export type ConfigFileExtension = ".ts" | ".js" | ".mjs";

export interface ResolvedConfigFile {
  path: string;
  ext: ConfigFileExtension;
}

export interface ResolvedConfig {
  /** Absolute path to config file (null if programmatic) */
  configPath: string | null;

  /** Working directory */
  cwd: string;

  /** Collection configurations */
  collections: AnyCollection[];

  /** Validation mode */
  mode: ValidationMode;

  /** Original callbacks (preserved from EngineConfig) */
  onValidationWarning?: EngineConfig["onValidationWarning"];
  onSlugCollision?: EngineConfig["onSlugCollision"];
  onTransformError?: EngineConfig["onTransformError"];
}

/**
 * Find config file in directory.
 */
export async function resolveConfigFile(cwd: string): Promise<ResolvedConfigFile | undefined> {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(cwd, name);
    try {
      await access(candidate);
      const ext = path.extname(candidate) as ConfigFileExtension;
      return { path: candidate, ext };
    } catch {
      // Continue to next candidate
    }
  }
  return undefined;
}

/**
 * Load config from file using jiti.
 */
async function loadConfigFile(configPath: string): Promise<EngineConfig> {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(configPath);
  const mod = await jiti.import(configPath);
  const config = (mod as { default?: unknown }).default ?? mod;

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(
      `Invalid config at ${configPath}: expected object with collections array`
    );
  }

  return config as EngineConfig;
}

/**
 * Validate config structure.
 */
function validateConfig(config: EngineConfig, source: string): void {
  if (!config.collections) {
    throw new Error(
      `Invalid config (${source}): missing "collections" property`
    );
  }

  if (!Array.isArray(config.collections)) {
    throw new Error(
      `Invalid config (${source}): "collections" must be an array`
    );
  }

  for (let i = 0; i < config.collections.length; i++) {
    const col = config.collections[i];
    if (!col.name || typeof col.name !== "string") {
      throw new Error(
        `Invalid config (${source}): collection[${i}] missing "name" property`
      );
    }
    if (!col.directory || typeof col.directory !== "string") {
      throw new Error(
        `Invalid config (${source}): collection "${col.name}" missing "directory" property`
      );
    }
    if (!col.schema) {
      throw new Error(
        `Invalid config (${source}): collection "${col.name}" missing "schema" property`
      );
    }
  }
}

/**
 * Resolve configuration from file or programmatic config.
 */
export async function resolveConfig(
  cwd: string,
  programmaticConfig?: EngineConfig
): Promise<ResolvedConfig> {
  // Use programmatic config if provided
  if (programmaticConfig) {
    validateConfig(programmaticConfig, "programmatic");
    return {
      configPath: null,
      cwd,
      collections: programmaticConfig.collections,
      mode: programmaticConfig.mode ?? "development",
      onValidationWarning: programmaticConfig.onValidationWarning,
      onSlugCollision: programmaticConfig.onSlugCollision,
      onTransformError: programmaticConfig.onTransformError,
    };
  }

  // Find and load config file
  const configFile = await resolveConfigFile(cwd);

  if (!configFile) {
    throw new Error(
      `No docks.config.{ts,js,mjs} found in ${cwd}. ` +
      `Create a config file with defineConfig({ collections: [...] })`
    );
  }

  const config = await loadConfigFile(configFile.path);
  validateConfig(config, configFile.path);

  return {
    configPath: configFile.path,
    cwd,
    collections: config.collections,
    mode: config.mode ?? "development",
    onValidationWarning: config.onValidationWarning,
    onSlugCollision: config.onSlugCollision,
    onTransformError: config.onTransformError,
  };
}
```

### 2. `packages/core/src/collector.ts` (New File)

```typescript
import { stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AnyCollection } from "./types";
import type { ResolvedConfig } from "./config";

export interface CollectedFile {
  /** Absolute file path */
  absolutePath: string;

  /** Path relative to collection directory */
  relativePath: string;

  /** Collection this file belongs to */
  collection: AnyCollection;
}

/**
 * Normalize include/exclude patterns to array.
 */
function normalizePatterns(
  patterns: string | string[] | undefined,
  defaultPattern?: string
): string[] {
  if (patterns === undefined) {
    return defaultPattern ? [defaultPattern] : [];
  }
  return Array.isArray(patterns) ? patterns : [patterns];
}

/**
 * Collect files for a single collection.
 */
async function collectCollection(
  collection: AnyCollection,
  cwd: string
): Promise<CollectedFile[]> {
  const absoluteDir = path.isAbsolute(collection.directory)
    ? collection.directory
    : path.join(cwd, collection.directory);

  // Check if directory exists
  try {
    const stats = await stat(absoluteDir);
    if (!stats.isDirectory()) {
      console.warn(
        `[docks] "${collection.directory}" is not a directory, ` +
        `skipping collection "${collection.name}"`
      );
      return [];
    }
  } catch {
    console.warn(
      `[docks] Directory "${collection.directory}" not found, ` +
      `skipping collection "${collection.name}"`
    );
    return [];
  }

  // Build glob patterns
  const include = normalizePatterns(collection.include, "**/*.md");
  const exclude = normalizePatterns(collection.exclude);

  // Find matching files
  const paths = await fg(include, {
    cwd: absoluteDir,
    absolute: true,
    ignore: ["**/node_modules/**", ...exclude],
  });

  return paths.map((absolutePath) => ({
    absolutePath,
    relativePath: path.relative(absoluteDir, absolutePath),
    collection,
  }));
}

/**
 * Collect files from all configured collections.
 */
export async function collect(config: ResolvedConfig): Promise<CollectedFile[]> {
  const results = await Promise.all(
    config.collections.map((collection) => collectCollection(collection, config.cwd))
  );

  return results.flat();
}

/**
 * Collect files for a specific collection (useful for watch mode).
 */
export async function collectOne(
  collection: AnyCollection,
  cwd: string
): Promise<CollectedFile[]> {
  return collectCollection(collection, cwd);
}
```

## Tests

### `packages/core/src/__tests__/config.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveConfig, resolveConfigFile, CONFIG_FILE_NAMES } from "../config";
import { z } from "zod";

describe("config", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docks-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("resolveConfigFile", () => {
    it("finds docks.config.ts", async () => {
      await writeFile(path.join(tempDir, "docks.config.ts"), "export default {}");

      const result = await resolveConfigFile(tempDir);

      expect(result?.ext).toBe(".ts");
      expect(result?.path).toContain("docks.config.ts");
    });

    it("returns undefined when no config found", async () => {
      const result = await resolveConfigFile(tempDir);

      expect(result).toBeUndefined();
    });

    it("prefers .ts over .js", async () => {
      await writeFile(path.join(tempDir, "docks.config.ts"), "export default {}");
      await writeFile(path.join(tempDir, "docks.config.js"), "module.exports = {}");

      const result = await resolveConfigFile(tempDir);

      expect(result?.ext).toBe(".ts");
    });
  });

  describe("resolveConfig", () => {
    it("throws when no config file and no programmatic config", async () => {
      await expect(resolveConfig(tempDir)).rejects.toThrow(
        "No docks.config.{ts,js,mjs} found"
      );
    });

    it("uses programmatic config when provided", async () => {
      const config = {
        collections: [
          {
            name: "posts",
            directory: "content/posts",
            schema: z.object({ title: z.string() }),
          },
        ],
      };

      const result = await resolveConfig(tempDir, config as any);

      expect(result.configPath).toBeNull();
      expect(result.collections).toHaveLength(1);
      expect(result.collections[0].name).toBe("posts");
    });

    it("validates collections is an array", async () => {
      const config = { collections: "not-an-array" };

      await expect(resolveConfig(tempDir, config as any)).rejects.toThrow(
        '"collections" must be an array'
      );
    });

    it("validates collection has name", async () => {
      const config = {
        collections: [{ directory: "content", schema: {} }],
      };

      await expect(resolveConfig(tempDir, config as any)).rejects.toThrow(
        'collection[0] missing "name"'
      );
    });

    it("validates collection has directory", async () => {
      const config = {
        collections: [{ name: "posts", schema: {} }],
      };

      await expect(resolveConfig(tempDir, config as any)).rejects.toThrow(
        'collection "posts" missing "directory"'
      );
    });

    it("validates collection has schema", async () => {
      const config = {
        collections: [{ name: "posts", directory: "content" }],
      };

      await expect(resolveConfig(tempDir, config as any)).rejects.toThrow(
        'collection "posts" missing "schema"'
      );
    });

    it("defaults mode to development", async () => {
      const config = {
        collections: [
          { name: "posts", directory: "content", schema: z.object({}) },
        ],
      };

      const result = await resolveConfig(tempDir, config as any);

      expect(result.mode).toBe("development");
    });

    it("preserves callbacks", async () => {
      const onValidationWarning = () => {};
      const config = {
        collections: [
          { name: "posts", directory: "content", schema: z.object({}) },
        ],
        onValidationWarning,
      };

      const result = await resolveConfig(tempDir, config as any);

      expect(result.onValidationWarning).toBe(onValidationWarning);
    });
  });
});
```

### `packages/core/src/__tests__/collector.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collect, collectOne } from "../collector";
import { z } from "zod";

describe("collector", () => {
  let tempDir: string;
  let contentDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "docks-test-"));
    contentDir = path.join(tempDir, "content", "posts");
    await mkdir(contentDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const createCollection = (overrides = {}) => ({
    name: "posts",
    directory: "content/posts",
    schema: z.object({ title: z.string() }),
    ...overrides,
  });

  describe("collect", () => {
    it("finds markdown files", async () => {
      await writeFile(path.join(contentDir, "post1.md"), "# Post 1");
      await writeFile(path.join(contentDir, "post2.md"), "# Post 2");

      const config = {
        cwd: tempDir,
        collections: [createCollection()],
        mode: "development" as const,
      };

      const files = await collect(config);

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.relativePath).sort()).toEqual(["post1.md", "post2.md"]);
    });

    it("respects include patterns", async () => {
      await writeFile(path.join(contentDir, "post.md"), "# Post");
      await writeFile(path.join(contentDir, "post.mdx"), "# MDX Post");

      const config = {
        cwd: tempDir,
        collections: [createCollection({ include: "**/*.mdx" })],
        mode: "development" as const,
      };

      const files = await collect(config);

      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe("post.mdx");
    });

    it("respects exclude patterns", async () => {
      await writeFile(path.join(contentDir, "post.md"), "# Post");
      await mkdir(path.join(contentDir, "drafts"));
      await writeFile(path.join(contentDir, "drafts", "draft.md"), "# Draft");

      const config = {
        cwd: tempDir,
        collections: [createCollection({ exclude: "**/drafts/**" })],
        mode: "development" as const,
      };

      const files = await collect(config);

      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe("post.md");
    });

    it("handles nested directories", async () => {
      await mkdir(path.join(contentDir, "2024"));
      await writeFile(path.join(contentDir, "2024", "nested.md"), "# Nested");

      const config = {
        cwd: tempDir,
        collections: [createCollection()],
        mode: "development" as const,
      };

      const files = await collect(config);

      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe(path.join("2024", "nested.md"));
    });

    it("handles missing directory gracefully", async () => {
      const config = {
        cwd: tempDir,
        collections: [createCollection({ directory: "content/missing" })],
        mode: "development" as const,
      };

      const files = await collect(config);

      expect(files).toHaveLength(0);
    });

    it("collects from multiple collections", async () => {
      const pagesDir = path.join(tempDir, "content", "pages");
      await mkdir(pagesDir, { recursive: true });
      await writeFile(path.join(contentDir, "post.md"), "# Post");
      await writeFile(path.join(pagesDir, "about.md"), "# About");

      const config = {
        cwd: tempDir,
        collections: [
          createCollection(),
          createCollection({ name: "pages", directory: "content/pages" }),
        ],
        mode: "development" as const,
      };

      const files = await collect(config);

      expect(files).toHaveLength(2);
      expect(files.find((f) => f.collection.name === "posts")).toBeTruthy();
      expect(files.find((f) => f.collection.name === "pages")).toBeTruthy();
    });

    it("ignores node_modules", async () => {
      const nmDir = path.join(contentDir, "node_modules");
      await mkdir(nmDir, { recursive: true });
      await writeFile(path.join(nmDir, "ignored.md"), "# Ignored");
      await writeFile(path.join(contentDir, "post.md"), "# Post");

      const config = {
        cwd: tempDir,
        collections: [createCollection()],
        mode: "development" as const,
      };

      const files = await collect(config);

      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe("post.md");
    });

    it("attaches collection reference to files", async () => {
      await writeFile(path.join(contentDir, "post.md"), "# Post");

      const collection = createCollection();
      const config = {
        cwd: tempDir,
        collections: [collection],
        mode: "development" as const,
      };

      const files = await collect(config);

      expect(files[0].collection).toBe(collection);
    });
  });

  describe("collectOne", () => {
    it("collects for a single collection", async () => {
      await writeFile(path.join(contentDir, "post.md"), "# Post");

      const files = await collectOne(createCollection(), tempDir);

      expect(files).toHaveLength(1);
    });
  });
});
```

## Acceptance Criteria

- [ ] Config file is found and loaded correctly
- [ ] Programmatic config works without file
- [ ] Config validation catches missing required fields
- [ ] Collector finds files matching include patterns
- [ ] Collector excludes files matching exclude patterns
- [ ] Missing directories are handled gracefully (warning, not error)
- [ ] node_modules is always ignored
- [ ] Multiple collections are collected in parallel
- [ ] All tests pass

## Notes

- The collector returns files with their collection reference attached
- Pattern normalization handles both string and array patterns
- Config validation provides helpful error messages
