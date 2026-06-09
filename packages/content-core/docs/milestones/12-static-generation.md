# Milestone 12: Static File Generation with Strongly-Typed Query API

## Executive Summary

Generate static JavaScript data files at build time while preserving the strongly-typed `getCollection`/`getEntry` query API. The generated files are an implementation detail - users continue using the same API everywhere.

```typescript
// This works identically in SSR, SSG, and SPA
const posts = await getCollection('posts')
//    ^? Entry<{ title: string; date: Date }, { readingTime: number }>[]

const post = await getEntry('posts', 'hello-world')
//    ^? Entry<{ title: string; date: Date }, { readingTime: number }> | undefined
```

---

## Problem Statement

The current runtime uses Node.js APIs that crash in browsers:

```typescript
// packages/core/src/runtime.ts:29
async function initEngine(cwd = process.cwd()): Promise<Engine> {  // ❌ Browser
  // ...
  const resolved = await resolveConfig(cwd);  // Uses fs.access() ❌ Browser
  const engine = createEngine(config);        // Uses fs, path, chokidar ❌ Browser
```

## Solution Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              BUILD TIME (Node.js)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   docks.config.ts ──► resolveConfig() ──► createEngine() ──► scan()      │
│                                                      │                      │
│                                                      ▼                      │
│                                              ┌───────────────┐              │
│                                              │  Engine State │              │
│                                              │  - entries[]  │              │
│                                              │  - schemas    │              │
│                                              └───────┬───────┘              │
│                                                      │                      │
│                         ┌────────────────────────────┼────────────────┐     │
│                         ▼                            ▼                ▼     │
│              ┌──────────────────┐     ┌──────────────────┐  ┌─────────────┐ │
│              │ .docks/generated│    │ .docks/generated│  │types.d.ts  │ │
│              │ /posts.js        │     │ /index.js        │  │(module aug)│ │
│              │                  │     │                  │  │            │ │
│              │ export default   │     │ export * from    │  │declare mod │ │
│              │ [{ id, slug, ... │     │ './posts.js'     │  │"@usedocks/  │ │
│              │ }]               │     │                  │  │core" {...} │ │
│              └──────────────────┘     └──────────────────┘  └─────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           RUNTIME (Browser OR Server)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   import { getCollection } from '@usedocks/core'                             │
│                    │                                                        │
│                    ▼                                                        │
│   ┌────────────────────────────────────────────────────────────────────┐    │
│   │  getCollection('posts')                                            │    │
│   │       │                                                            │    │
│   │       ├─── isServer? ──► initEngine() ──► engine.getCollection()   │    │
│   │       │                  (filesystem-based, current behavior)      │    │
│   │       │                                                            │    │
│   │       └─── isBrowser? ──► import('.docks/generated/posts.js')    │    │
│   │                          (static import, bundled at build time)    │    │
│   └────────────────────────────────────────────────────────────────────┘    │
│                    │                                                        │
│                    ▼                                                        │
│   Entry<PostData, PostTransformed>[]  ◄── Strongly typed via CollectionRegistry
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Type System Design

### How Strong Typing Works

The type system uses TypeScript's module augmentation to populate `CollectionRegistry`:

```typescript
// User's docks.config.ts
const posts = defineCollection({
  name: 'posts',
  directory: 'content/posts',
  include: '**/*.md',
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    draft: z.boolean().default(false),
  }),
  transform: (doc) => ({
    readingTime: Math.ceil(doc.content.split(/\s+/).length / 200),
  }),
});
```

At build time, `generateTypes()` produces:

```typescript
// .docks/generated/types.d.ts (or node_modules/.docks/types.d.ts)
import "@usedocks/core";

declare module "@usedocks/core" {
  interface CollectionRegistry {
    "posts": {
      data: { title: string; date: Date; draft?: boolean };
      transformed: { readingTime: number };
    };
  }
}
```

This augments the `CollectionRegistry` interface in `@usedocks/core`, which is used by `getCollection` and `getEntry`:

```typescript
// packages/core/src/types.ts (existing)
export interface CollectionRegistry {}

export type CollectionData<K extends keyof CollectionRegistry> =
  CollectionRegistry[K] extends { data: infer D } ? D : Record<string, unknown>;

export type CollectionTransformed<K extends keyof CollectionRegistry> =
  CollectionRegistry[K] extends { transformed: infer T } ? T : undefined;
```

```typescript
// packages/core/src/runtime.ts (existing signatures)
export async function getCollection<K extends keyof CollectionRegistry>(
  name: K,
): Promise<
  Entry<
    CollectionData<K> & Record<string, unknown>,
    (CollectionTransformed<K> & Record<string, unknown>) | undefined
  >[]
>;

export async function getEntry<K extends keyof CollectionRegistry>(
  collection: K,
  slug: string,
): Promise<
  Entry<
    CollectionData<K> & Record<string, unknown>,
    (CollectionTransformed<K> & Record<string, unknown>) | undefined
  > | undefined
>;
```

**Result:** When the user calls `getCollection('posts')`, TypeScript resolves the return type through the augmented registry.

---

## Implementation Details

### File 1: `packages/core/src/generator.ts` (NEW)

This is the core of the change - a new module that generates static data files.

```typescript
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { resolveConfig, type ResolvedConfig } from "./config";
import { createEngine } from "./engine";
import { generateTypes } from "./typegen";
import type { Engine, RuntimeEntry, AnyCollection } from "./types";

// ============================================================================
// Types
// ============================================================================

export interface GenerateOptions {
  /** Working directory containing docks.config.{ts,js,mjs}. Defaults to process.cwd() */
  cwd?: string;

  /** Output directory for generated files. Defaults to `${cwd}/.docks/generated` */
  outDir?: string;

  /** Also write types to node_modules/.docks for IDE support. Defaults to true */
  writeNodeModulesTypes?: boolean;

  /** Delete output directory before generating. Defaults to true */
  clean?: boolean;

  /** Log generation progress. Defaults to false */
  verbose?: boolean;
}

export interface GenerateResult {
  /** Absolute path to output directory */
  outDir: string;

  /** Names of generated collections */
  collections: string[];

  /** Total number of entries across all collections */
  entryCount: number;

  /** Absolute path to generated types.d.ts */
  typesPath: string;

  /** Absolute path to generated index.js */
  indexPath: string;

  /** Time taken in milliseconds */
  duration: number;
}

export interface WatchOptions extends GenerateOptions {
  /** Called after each successful regeneration */
  onGenerate?: (result: GenerateResult) => void;

  /** Called when an error occurs during regeneration */
  onError?: (error: Error) => void;

  /** Debounce delay in milliseconds. Defaults to 100 */
  debounce?: number;
}

export interface WatchHandle {
  /** Stop watching and clean up */
  close: () => Promise<void>;

  /** Manually trigger a regeneration */
  regenerate: () => Promise<GenerateResult>;
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize entries to JavaScript module content.
 *
 * Handles special types:
 * - Date → ISO string with revival marker
 * - undefined → excluded from JSON (standard behavior)
 * - Functions → excluded (not serializable)
 */
function serializeEntries(entries: RuntimeEntry[]): string {
  const serialized = JSON.stringify(
    entries,
    (key, value) => {
      // Convert Date to ISO string with marker for revival
      if (value instanceof Date) {
        return { __docks_date: value.toISOString() };
      }
      return value;
    },
    2
  );

  return `// Generated by @usedocks/core - DO NOT EDIT
// This file contains pre-built content data for browser usage

const data = ${serialized};

// Revive Date objects
function revive(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj.__docks_date) return new Date(obj.__docks_date);
  if (Array.isArray(obj)) return obj.map(revive);
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = revive(v);
  }
  return result;
}

export default revive(data);
`;
}

/**
 * Generate the index.js that re-exports all collections.
 */
function generateIndex(collections: string[]): string {
  const imports = collections
    .map((name) => `import ${name} from "./${name}.js";`)
    .join("\n");

  const exports = collections.join(", ");

  return `// Generated by @usedocks/core - DO NOT EDIT
${imports}

export { ${exports} };

// Collection lookup for runtime API
export const __collections = { ${exports} };
`;
}

/**
 * Generate TypeScript declarations for the generated data files.
 */
function generateDataTypes(collections: AnyCollection[], config: ResolvedConfig): string {
  const lines: string[] = [
    "// Generated by @usedocks/core - DO NOT EDIT",
    "",
    'import type { Entry, CollectionData, CollectionTransformed } from "@usedocks/core";',
    "",
  ];

  for (const col of collections) {
    lines.push(
      `export declare const ${col.name}: Entry<CollectionData<"${col.name}">, CollectionTransformed<"${col.name}">>[];`
    );
  }

  lines.push("");
  lines.push("export declare const __collections: {");
  for (const col of collections) {
    lines.push(
      `  ${col.name}: Entry<CollectionData<"${col.name}">, CollectionTransformed<"${col.name}">>[];`
    );
  }
  lines.push("};");
  lines.push("");

  return lines.join("\n");
}

// ============================================================================
// Generator
// ============================================================================

export async function generate(options: GenerateOptions = {}): Promise<GenerateResult> {
  const start = performance.now();
  const cwd = options.cwd ?? process.cwd();
  const outDir = options.outDir ?? path.join(cwd, ".docks", "generated");
  const writeNodeModulesTypes = options.writeNodeModulesTypes ?? true;
  const verbose = options.verbose ?? false;

  const log = (...args: unknown[]) => {
    if (verbose) console.log("[docks]", ...args);
  };

  // Clean output directory
  if (options.clean !== false) {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
  await mkdir(outDir, { recursive: true });

  log("Resolving config...");
  const config = await resolveConfig(cwd);

  log("Creating engine...");
  const engine = createEngine({ ...config, cwd });
  await engine.scan();

  // Generate collection data files
  const collectionNames: string[] = [];
  let entryCount = 0;

  for (const col of engine.getCollections()) {
    log(`Generating ${col.name} (${col.entries.length} entries)...`);

    const content = serializeEntries(col.entries);
    await writeFile(path.join(outDir, `${col.name}.js`), content, "utf-8");

    collectionNames.push(col.name);
    entryCount += col.entries.length;
  }

  // Generate index.js
  const indexContent = generateIndex(collectionNames);
  const indexPath = path.join(outDir, "index.js");
  await writeFile(indexPath, indexContent, "utf-8");

  // Generate data.d.ts (types for the generated JS files)
  const dataTypesContent = generateDataTypes(config.collections, config);
  await writeFile(path.join(outDir, "index.d.ts"), dataTypesContent, "utf-8");

  // Generate module augmentation types (for getCollection/getEntry)
  const moduleTypesContent = generateTypes(config.collections);
  const typesPath = path.join(outDir, "types.d.ts");
  await writeFile(typesPath, moduleTypesContent, "utf-8");

  // Also write to node_modules for IDE support
  if (writeNodeModulesTypes) {
    const nodeModulesDir = path.join(cwd, "node_modules", ".docks");
    await mkdir(nodeModulesDir, { recursive: true });
    await writeFile(path.join(nodeModulesDir, "types.d.ts"), moduleTypesContent, "utf-8");
  }

  const duration = performance.now() - start;
  log(`Generated ${entryCount} entries in ${duration.toFixed(0)}ms`);

  return {
    outDir,
    collections: collectionNames,
    entryCount,
    typesPath,
    indexPath,
    duration,
  };
}

// ============================================================================
// Watcher
// ============================================================================

export function watch(options: WatchOptions = {}): WatchHandle {
  const cwd = options.cwd ?? process.cwd();
  const debounceMs = options.debounce ?? 100;

  let watcher: FSWatcher | null = null;
  let timeout: NodeJS.Timeout | null = null;
  let isGenerating = false;
  let pendingRegenerate = false;

  const regenerate = async (): Promise<GenerateResult> => {
    if (isGenerating) {
      pendingRegenerate = true;
      // Wait for current generation to finish, then retry
      return new Promise((resolve) => {
        const check = setInterval(async () => {
          if (!isGenerating) {
            clearInterval(check);
            resolve(await regenerate());
          }
        }, 50);
      });
    }

    isGenerating = true;
    pendingRegenerate = false;

    try {
      const result = await generate({ ...options, clean: false });
      options.onGenerate?.(result);
      return result;
    } catch (error) {
      options.onError?.(error as Error);
      throw error;
    } finally {
      isGenerating = false;
      if (pendingRegenerate) {
        // Another change came in while we were generating
        regenerate().catch(() => {});
      }
    }
  };

  const debouncedRegenerate = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => regenerate().catch(() => {}), debounceMs);
  };

  // Start initial generation, then set up watcher
  regenerate()
    .then(async () => {
      // Resolve config to get content directories
      const config = await resolveConfig(cwd);
      const watchPaths = config.collections.map((col) =>
        path.isAbsolute(col.directory) ? col.directory : path.join(cwd, col.directory)
      );

      watcher = chokidarWatch(watchPaths, {
        ignoreInitial: true,
        ignored: ["**/node_modules/**", "**/.docks/**", "**/.git/**"],
      });

      watcher.on("add", debouncedRegenerate);
      watcher.on("change", debouncedRegenerate);
      watcher.on("unlink", debouncedRegenerate);
    })
    .catch((error) => {
      options.onError?.(error as Error);
    });

  return {
    close: async () => {
      if (timeout) clearTimeout(timeout);
      await watcher?.close();
    },
    regenerate,
  };
}
```

---

### File 2: `packages/core/src/runtime.ts` (UPDATED)

Update the runtime to support both server (filesystem) and browser (static import) contexts.

```typescript
import type {
  Collection,
  CollectionData,
  CollectionRegistry,
  CollectionTransformed,
  Engine,
  EngineConfig,
  Entry,
  RuntimeEntry,
} from "./types";

// ============================================================================
// Environment Detection
// ============================================================================

const isServer = typeof process !== "undefined"
  && process.versions?.node !== undefined
  && typeof window === "undefined";

// ============================================================================
// Server Runtime (filesystem-based)
// ============================================================================

const RUNTIME_KEY = Symbol.for("@usedocks/core/runtime");

interface RuntimeStore {
  engine: Engine | null;
  promise: Promise<Engine> | null;
  config: EngineConfig | null;
}

function getStore(): RuntimeStore {
  const g = globalThis as unknown as Record<symbol, RuntimeStore | undefined>;
  if (!g[RUNTIME_KEY]) {
    g[RUNTIME_KEY] = { engine: null, promise: null, config: null };
  }
  return g[RUNTIME_KEY];
}

async function initServerEngine(cwd = process.cwd()): Promise<Engine> {
  // Dynamic imports to avoid loading Node.js modules in browser bundles
  const { createEngine } = await import("./engine");
  const { resolveConfig } = await import("./config");

  const store = getStore();

  if (store.engine) return store.engine;
  if (store.promise) return store.promise;

  store.promise = (async () => {
    let config: EngineConfig;

    if (store.config) {
      config = { ...store.config, cwd: store.config.cwd ?? cwd };
    } else {
      const resolved = await resolveConfig(cwd);
      config = { collections: resolved.collections, cwd, mode: resolved.mode };
    }

    const engine = createEngine(config);
    await engine.scan();
    return engine;
  })();

  try {
    store.engine = await store.promise;
    return store.engine;
  } finally {
    store.promise = null;
  }
}

// ============================================================================
// Browser Runtime (static import-based)
// ============================================================================

interface BrowserDataStore {
  collections: Record<string, RuntimeEntry[]> | null;
  promise: Promise<Record<string, RuntimeEntry[]>> | null;
}

const BROWSER_STORE_KEY = Symbol.for("@usedocks/core/browser-store");

function getBrowserStore(): BrowserDataStore {
  const g = globalThis as unknown as Record<symbol, BrowserDataStore | undefined>;
  if (!g[BROWSER_STORE_KEY]) {
    g[BROWSER_STORE_KEY] = { collections: null, promise: null };
  }
  return g[BROWSER_STORE_KEY];
}

async function loadBrowserData(): Promise<Record<string, RuntimeEntry[]>> {
  const store = getBrowserStore();

  if (store.collections) return store.collections;
  if (store.promise) return store.promise;

  store.promise = (async () => {
    try {
      // This import is resolved by the bundler to .docks/generated/index.js
      // via tsconfig paths or bundler alias
      const data = await import("@usedocks/content");
      return data.__collections as Record<string, RuntimeEntry[]>;
    } catch (error) {
      throw new Error(
        "Docks: Failed to load content data. " +
        "Ensure you have run 'docks generate' and configured tsconfig paths. " +
        `Original error: ${error instanceof Error ? error.message : error}`
      );
    }
  })();

  try {
    store.collections = await store.promise;
    return store.collections;
  } finally {
    store.promise = null;
  }
}

// ============================================================================
// Public API - Configuration
// ============================================================================

/**
 * Pre-configure the runtime engine (server-side only).
 * Call this before any getCollection/getEntry calls to use a custom config.
 */
export function setRuntimeConfig(config: EngineConfig): void {
  if (!isServer) {
    console.warn("Docks: setRuntimeConfig() has no effect in browser context");
    return;
  }
  const store = getStore();
  store.config = config;
  store.engine = null;
  store.promise = null;
}

/**
 * Get the underlying engine instance (server-side only).
 * Useful for advanced use cases like accessing the watch API.
 */
export async function getRuntimeEngine(cwd?: string): Promise<Engine> {
  if (!isServer) {
    throw new Error("Docks: getRuntimeEngine() is only available on the server");
  }
  return initServerEngine(cwd);
}

/**
 * Clear the cached engine instance, forcing reinitialization on next query.
 */
export function invalidateRuntimeEngine(): void {
  if (isServer) {
    const store = getStore();
    store.engine = null;
    store.promise = null;
    store.config = null;
  } else {
    const store = getBrowserStore();
    store.collections = null;
    store.promise = null;
  }
}

/**
 * Manually set browser data (used by plugins for SSR hydration).
 * @internal
 */
export function __setBrowserData(collections: Record<string, RuntimeEntry[]>): void {
  const store = getBrowserStore();
  store.collections = collections;
}

// ============================================================================
// Public API - Query Functions
// ============================================================================

/**
 * Get all entries in a collection.
 *
 * @example
 * ```typescript
 * const posts = await getCollection('posts');
 * // posts: Entry<{ title: string; date: Date }, { readingTime: number }>[]
 * ```
 */
export async function getCollection<K extends keyof CollectionRegistry>(
  name: K,
): Promise<
  Entry<
    CollectionData<K> & Record<string, unknown>,
    (CollectionTransformed<K> & Record<string, unknown>) | undefined
  >[]
>;
export async function getCollection(name: string): Promise<RuntimeEntry[]>;
export async function getCollection(name: string): Promise<RuntimeEntry[]> {
  if (isServer) {
    const engine = await initServerEngine();
    return engine.getCollection(name);
  } else {
    const collections = await loadBrowserData();
    return collections[name] ?? [];
  }
}

/**
 * Get a single entry by collection name and slug.
 *
 * @example
 * ```typescript
 * const post = await getEntry('posts', 'hello-world');
 * // post: Entry<{ title: string; date: Date }, { readingTime: number }> | undefined
 * ```
 */
export async function getEntry<K extends keyof CollectionRegistry>(
  collection: K,
  slug: string,
): Promise<
  | Entry<
      CollectionData<K> & Record<string, unknown>,
      (CollectionTransformed<K> & Record<string, unknown>) | undefined
    >
  | undefined
>;
export async function getEntry(collection: string, slug: string): Promise<RuntimeEntry | undefined>;
export async function getEntry(collection: string, slug: string): Promise<RuntimeEntry | undefined> {
  if (isServer) {
    const engine = await initServerEngine();
    return engine.getEntry(collection, slug);
  } else {
    const collections = await loadBrowserData();
    const entries = collections[collection];
    return entries?.find((e) => e.slug === slug);
  }
}

/**
 * Get all collections with their entries.
 *
 * @example
 * ```typescript
 * const all = await getCollections();
 * // all: { name: string; entries: Entry[] }[]
 * ```
 */
export async function getCollections(): Promise<Collection[]> {
  if (isServer) {
    const engine = await initServerEngine();
    return engine.getCollections();
  } else {
    const collections = await loadBrowserData();
    return Object.entries(collections).map(([name, entries]) => ({
      name,
      entries,
    }));
  }
}
```

---

### File 3: `packages/core/src/cli.ts` (NEW)

Add a CLI for running generation outside of bundler plugins.

```typescript
#!/usr/bin/env node

import { parseArgs } from "node:util";
import { generate, watch } from "./generator";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h" },
    watch: { type: "boolean", short: "w" },
    outDir: { type: "string", short: "o" },
    cwd: { type: "string", short: "c" },
    verbose: { type: "boolean", short: "v" },
  },
});

const command = positionals[0] ?? "generate";

function showHelp() {
  console.log(`
docks - Static content generation for TypeScript applications

Usage:
  docks [command] [options]

Commands:
  generate    Generate static content files (default)
  dev         Generate and watch for changes

Options:
  -o, --outDir <path>   Output directory (default: .docks/generated)
  -c, --cwd <path>      Working directory (default: current directory)
  -w, --watch           Watch for changes (same as 'dev' command)
  -v, --verbose         Show detailed output
  -h, --help            Show this help message

Examples:
  docks                       # Generate once
  docks generate              # Generate once (explicit)
  docks dev                   # Watch mode
  docks generate -v           # Verbose output
  docks -o dist/content       # Custom output directory
`);
}

if (values.help) {
  showHelp();
  process.exit(0);
}

const options = {
  cwd: values.cwd,
  outDir: values.outDir,
  verbose: values.verbose,
};

async function main() {
  if (command === "dev" || values.watch) {
    console.log("Docks: Watching for content changes...");
    console.log("Press Ctrl+C to stop\n");

    const handle = watch({
      ...options,
      onGenerate: (result) => {
        const time = result.duration.toFixed(0);
        console.log(
          `[${new Date().toLocaleTimeString()}] ` +
          `Generated ${result.entryCount} entries in ${time}ms`
        );
      },
      onError: (error) => {
        console.error(`[${new Date().toLocaleTimeString()}] Error:`, error.message);
      },
    });

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\nShutting down...");
      await handle.close();
      process.exit(0);
    });
  } else if (command === "generate") {
    try {
      const result = await generate(options);
      console.log(`Generated ${result.entryCount} entries from ${result.collections.length} collections`);
      console.log(`Output: ${result.outDir}`);
      if (values.verbose) {
        console.log(`Collections: ${result.collections.join(", ")}`);
        console.log(`Duration: ${result.duration.toFixed(0)}ms`);
      }
    } catch (error) {
      console.error("Generation failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
  }
}

main();
```

---

### File 4: `packages/core/src/index.ts` (UPDATE)

Add new exports:

```typescript
// Config
export { resolveConfig } from "./config";
export type { ResolvedConfig } from "./config";

// Pipeline
export { runPipeline, pipeline } from "./pipeline";
export type { PipelineResult, PipelineOptions } from "./pipeline";

// Engine
export { createEngine } from "./engine";

// Runtime API
export {
  getEntry,
  getCollection,
  getCollections,
  getRuntimeEngine,
  setRuntimeConfig,
  invalidateRuntimeEngine,
} from "./runtime";

// Static Generation (NEW)
export { generate, watch } from "./generator";
export type { GenerateOptions, GenerateResult, WatchOptions, WatchHandle } from "./generator";

// Type generation
export { generateTypes } from "./typegen";

// Types
export { defineCollection, defineConfig, ValidationError, TransformError } from "./types";

export type {
  Collection,
  CollectionConfig,
  CollectionData,
  CollectionRegistry,
  CollectionSchema,
  CollectionTransformed,
  Document,
  DocumentMeta,
  Engine,
  EngineConfig,
  Entry,
  InferEntry,
  InferOutput,
  TransformContext,
  TransformFn,
  ValidationIssue,
  ValidationMode,
  WatchCallback,
  WatchEvent,
  AnyCollection,
  RuntimeEntry,
} from "./types";
```

---

### File 5: `packages/core/package.json` (UPDATE)

```json
{
  "name": "@usedocks/core",
  "version": "0.1.0",
  "description": "Schema-driven content engine for markdown in TypeScript applications",
  "type": "module",
  "sideEffects": false,
  "bin": {
    "docks": "./dist/cli.mjs"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.mts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.mjs",
      "default": "./dist/index.mjs"
    }
  },
  "main": "./dist/index.mjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.mts",
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsdown",
    "dev": "tsc --watch",
    "format": "oxfmt src --write",
    "format:check": "oxfmt src",
    "lint": "oxlint src",
    "lint:fix": "oxlint src --fix",
    "test": "vitest",
    "test:run": "vitest run",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run lint && npm run typecheck && npm run test:run && npm run build"
  }
}
```

Note: Removed the `/client` export - we no longer need a separate client entry point since the main runtime handles both server and browser contexts.

---

### File 6: `packages/core/tsdown.config.ts` (UPDATE)

Ensure CLI is built as executable:

```typescript
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  external: ["chokidar", "fast-glob", "gray-matter", "jiti", "p-limit", "picomatch"],
});
```

---

### File 7: `packages/vite-plugin/src/plugin.ts` (SIMPLIFIED)

```typescript
import { generate, watch, type GenerateResult, type WatchHandle } from "@usedocks/core";
import type { Plugin, ViteDevServer } from "vite";

export interface DocksPluginOptions {
  /** Enable debug logging */
  debug?: boolean;
  /** Custom output directory */
  outDir?: string;
}

export function docks(options: DocksPluginOptions = {}): Plugin {
  const { debug = false, outDir } = options;
  let watchHandle: WatchHandle | null = null;

  const log = (...args: unknown[]) => {
    if (debug) console.log("[docks]", ...args);
  };

  return {
    name: "docks",

    async buildStart() {
      log("Generating content...");
      const result = await generate({ outDir, verbose: debug });
      log(`Generated ${result.entryCount} entries in ${result.duration.toFixed(0)}ms`);
    },

    configureServer(server: ViteDevServer) {
      log("Starting watch mode...");

      watchHandle = watch({
        outDir,
        onGenerate: (result: GenerateResult) => {
          log(`Regenerated ${result.entryCount} entries`);
          // Trigger HMR
          server.ws.send({ type: "full-reload" });
        },
        onError: (error: Error) => {
          server.config.logger.error(`[docks] ${error.message}`);
        },
      });

      // Cleanup on server close
      server.httpServer?.on("close", () => {
        watchHandle?.close();
      });
    },

    async closeBundle() {
      await watchHandle?.close();
    },
  };
}
```

---

### File 8: `packages/vite-plugin/src/index.ts` (SIMPLIFIED)

```typescript
// Plugin
export { docks } from "./plugin";
export type { DocksPluginOptions } from "./plugin";

// Re-export core utilities for convenience
export {
  // Config
  defineCollection,
  defineConfig,

  // Runtime API
  getEntry,
  getCollection,
  getCollections,

  // Generation (advanced)
  generate,
  watch,

  // Errors
  ValidationError,
  TransformError,
} from "@usedocks/core";

// Re-export types
export type {
  AnyCollection,
  Collection,
  CollectionConfig,
  CollectionData,
  CollectionRegistry,
  CollectionSchema,
  CollectionTransformed,
  Entry,
  GenerateOptions,
  GenerateResult,
  WatchOptions,
  WatchHandle,
} from "@usedocks/core";
```

---

## Template Updates

### tsconfig.json (ALL TEMPLATES)

Add path mapping for `@usedocks/content`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@usedocks/content": ["./.docks/generated"],
      "@usedocks/content/*": ["./.docks/generated/*"]
    }
  },
  "include": [
    "src",
    ".docks/generated/types.d.ts"
  ]
}
```

### .gitignore (ALL TEMPLATES)

```gitignore
# Docks generated files
.docks/
```

### package.json scripts (ALL TEMPLATES)

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "generate": "docks generate"
  }
}
```

Note: The Vite plugin handles generation automatically. The `generate` script is for manual use or CI.

---

## Usage Examples

### SPA (vite-react, tanstack-router, vite-react-router)

```typescript
// Works in browser - data loaded from static files
import { getCollection, getEntry } from '@usedocks/core';

export const Route = createFileRoute('/')({
  loader: async () => {
    const posts = await getCollection('posts');
    //    ^? Entry<{ title: string; date: Date }, { readingTime: number }>[]
    return posts;
  },
  component: Home,
});

function Home() {
  const posts = Route.useLoaderData();
  // Fully typed!
}
```

### SSR (next, tanstack-start)

```typescript
// Works on server - data loaded from filesystem
import { getCollection, getEntry } from '@usedocks/core';

export async function loader() {
  const posts = await getCollection('posts');
  //    ^? Entry<{ title: string; date: Date }, { readingTime: number }>[]
  return posts;
}

// Same code, same types, different runtime behavior
```

### Direct Import (optional, for advanced use)

```typescript
// Skip the runtime, import directly
import { posts } from '@usedocks/content';
//       ^? Entry<{ title: string; date: Date }, { readingTime: number }>[]

// No await needed - data is already loaded
const featured = posts.filter(p => p.data.featured);
```

---

## Testing Requirements

### Unit Tests

```typescript
// packages/core/src/__tests__/generator.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generate, watch } from '../generator';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('generate', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), 'docks-test-'));

    // Create test config
    await writeFile(
      path.join(testDir, 'docks.config.ts'),
      `
import { defineConfig, defineCollection } from '@usedocks/core';
import { z } from 'zod';

export default defineConfig({
  collections: [
    defineCollection({
      name: 'posts',
      directory: 'content/posts',
      include: '**/*.md',
      schema: z.object({
        title: z.string(),
        date: z.coerce.date(),
      }),
    }),
  ],
});
`
    );

    // Create test content
    await mkdir(path.join(testDir, 'content/posts'), { recursive: true });
    await writeFile(
      path.join(testDir, 'content/posts/hello.md'),
      `---
title: Hello World
date: 2024-01-01
---

Content here.
`
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('generates collection files', async () => {
    const result = await generate({ cwd: testDir });

    expect(result.collections).toEqual(['posts']);
    expect(result.entryCount).toBe(1);

    // Check generated files exist
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(result.outDir, 'posts.js'))).toBe(true);
    expect(existsSync(path.join(result.outDir, 'index.js'))).toBe(true);
    expect(existsSync(path.join(result.outDir, 'index.d.ts'))).toBe(true);
    expect(existsSync(path.join(result.outDir, 'types.d.ts'))).toBe(true);
  });

  it('generates valid JavaScript', async () => {
    const result = await generate({ cwd: testDir });

    // Import the generated module
    const posts = await import(path.join(result.outDir, 'posts.js'));

    expect(posts.default).toHaveLength(1);
    expect(posts.default[0].slug).toBe('hello');
    expect(posts.default[0].data.title).toBe('Hello World');
    expect(posts.default[0].data.date).toBeInstanceOf(Date);
  });

  it('generates correct types', async () => {
    const result = await generate({ cwd: testDir });

    const { readFile } = await import('node:fs/promises');
    const types = await readFile(result.typesPath, 'utf-8');

    expect(types).toContain('interface CollectionRegistry');
    expect(types).toContain('"posts"');
    expect(types).toContain('title: string');
    expect(types).toContain('date: Date');
  });
});

describe('watch', () => {
  // Similar tests for watch functionality
});
```

### Integration Tests

```typescript
// packages/core/src/__tests__/runtime.integration.test.ts

describe('runtime - browser context', () => {
  it('loads data from generated files', async () => {
    // Mock the browser environment
    // Test that getCollection uses static imports
  });
});

describe('runtime - server context', () => {
  it('loads data from filesystem', async () => {
    // Test that getCollection uses engine
  });
});
```

---

## Acceptance Criteria

### Functionality
- [ ] `docks generate` CLI works standalone
- [ ] `docks dev` watches and regenerates on changes
- [ ] Vite plugin triggers generation on build
- [ ] Vite plugin triggers regeneration on HMR
- [ ] `getCollection` works in Node.js (filesystem)
- [ ] `getCollection` works in browser (static import)
- [ ] `getEntry` works in Node.js
- [ ] `getEntry` works in browser
- [ ] Date objects are properly serialized and revived

### Type Safety
- [ ] `getCollection('posts')` returns correctly typed entries
- [ ] `getEntry('posts', slug)` returns correctly typed entry
- [ ] TypeScript errors on invalid collection names
- [ ] Transform output types are preserved
- [ ] IDE autocomplete works for collection names

### Templates
- [ ] vite-react builds and runs
- [ ] vite-react-router builds and runs
- [ ] tanstack-router builds and runs
- [ ] tanstack-start builds and runs
- [ ] next builds and runs

### Performance
- [ ] Generation completes in < 1s for 100 entries
- [ ] Watch mode detects changes in < 100ms
- [ ] No memory leaks in watch mode

---

## Migration Guide

### From current Docks (broken SPA)

1. Update `@usedocks/core` and `@usedocks/vite-plugin`

2. Add to `tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "paths": {
         "@usedocks/content": ["./.docks/generated"],
         "@usedocks/content/*": ["./.docks/generated/*"]
       }
     },
     "include": ["src", ".docks/generated/types.d.ts"]
   }
   ```

3. Add to `.gitignore`:
   ```
   .docks/
   ```

4. No code changes needed - `getCollection`/`getEntry` API unchanged

### From content-collections

1. Replace imports:
   ```typescript
   // Before
   import { allPosts } from 'content-collections';

   // After
   import { getCollection } from '@usedocks/core';
   const posts = await getCollection('posts');
   ```

2. Update config format (see config migration in previous milestones)
