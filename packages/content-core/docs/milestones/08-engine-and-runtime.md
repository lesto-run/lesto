# Milestone 8: Engine & Runtime

## Objective
Rewrite engine to use pipeline stages and provide simplified runtime API.

## Dependencies
- Milestones 6-7 (pipeline, synchronizer)

## Deliverables
- [ ] `engine.ts` - Rewrite using pipeline
- [ ] `runtime.ts` - Simplified type-safe API
- [ ] `index.ts` - Updated exports
- [ ] Tests for engine and runtime

## Files to Modify

### `packages/core/src/engine.ts` (Rewrite)

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { resolveConfig, type ResolvedConfig } from "./config";
import { runPipeline } from "./pipeline";
import { createSynchronizer, type Synchronizer } from "./synchronizer";
import { generateTypes } from "./typegen";
import type { Collection, Entry, EngineConfig, WatchCallback, WatchEvent } from "./types";

export interface Engine {
  scan(): Promise<void>;
  watch(callback: WatchCallback): () => void;
  getCollections(): Collection[];
  getCollection(name: string): Entry[];
  getEntry(collection: string, slug: string): Entry | undefined;
  generateTypes(): string;
  writeTypes(outDir?: string): Promise<string>;
}

export function createEngine(config: EngineConfig): Engine {
  const cwd = config.cwd ?? process.cwd();

  let resolvedConfig: ResolvedConfig | null = null;
  let synchronizer: Synchronizer | null = null;
  let watcher: chokidar.FSWatcher | null = null;
  const watchCallbacks = new Set<WatchCallback>();

  return {
    async scan() {
      const result = await runPipeline({
        cwd,
        config,
        skipWrite: true,
      });

      resolvedConfig = result.config;

      // Initialize synchronizer with results
      synchronizer = createSynchronizer(result.config);

      // Build path map from files
      const pathMap = new Map<string, string>();
      for (const file of result.files) {
        const entry = result.entries.find(
          (e) => e.collection === file.collection.name &&
                 e._meta.path === file.relativePath
        );
        if (entry) {
          pathMap.set(file.absolutePath, entry.id);
        }
      }

      synchronizer.initialize(result.entries, pathMap);
    },

    watch(callback: WatchCallback) {
      watchCallbacks.add(callback);

      if (!watcher && resolvedConfig) {
        // Build watch paths
        const watchPaths = resolvedConfig.collections.map((col) =>
          path.isAbsolute(col.directory)
            ? col.directory
            : path.join(cwd, col.directory)
        );

        watcher = chokidar.watch(watchPaths, {
          ignoreInitial: true,
          ignored: ["**/node_modules/**"],
        });

        watcher.on("add", async (filePath) => {
          if (!synchronizer) return;
          const result = await synchronizer.changed(filePath);
          if (result) {
            const event: WatchEvent = {
              type: "add",
              path: filePath,
              collection: result.collection,
              entry: result.entry,
            };
            for (const cb of watchCallbacks) cb(event);
          }
        });

        watcher.on("change", async (filePath) => {
          if (!synchronizer) return;
          const result = await synchronizer.changed(filePath);
          if (result) {
            const event: WatchEvent = {
              type: "change",
              path: filePath,
              collection: result.collection,
              entry: result.entry,
            };
            for (const cb of watchCallbacks) cb(event);
          }
        });

        watcher.on("unlink", (filePath) => {
          if (!synchronizer) return;
          const result = synchronizer.deleted(filePath);
          if (result) {
            const event: WatchEvent = {
              type: "unlink",
              path: filePath,
              collection: result.collection,
              entry: result.entry,
            };
            for (const cb of watchCallbacks) cb(event);
          }
        });
      }

      return () => {
        watchCallbacks.delete(callback);
        if (watchCallbacks.size === 0 && watcher) {
          watcher.close();
          watcher = null;
        }
      };
    },

    getCollections() {
      if (!synchronizer) return [];
      const collections: Collection[] = [];
      const state = synchronizer.getState();
      for (const [name, entries] of state.byCollection) {
        if (entries.length > 0) {
          collections.push({ name, entries });
        }
      }
      return collections;
    },

    getCollection(name: string) {
      return synchronizer?.getCollection(name) ?? [];
    },

    getEntry(collection: string, slug: string) {
      return synchronizer?.getEntry(collection, slug);
    },

    generateTypes() {
      if (!resolvedConfig) return "";
      return generateTypes(resolvedConfig.collections);
    },

    async writeTypes(outDir?: string) {
      const dir = outDir ?? path.join(cwd, "node_modules", ".docks");
      await mkdir(dir, { recursive: true });

      const types = this.generateTypes();
      const typesPath = path.join(dir, "types.d.ts");
      await writeFile(typesPath, types, "utf-8");

      return typesPath;
    },
  };
}
```

### `packages/core/src/runtime.ts` (Simplify)

```typescript
import { createEngine } from "./engine";
import { resolveConfig } from "./config";
import type {
  Collection,
  CollectionData,
  CollectionRegistry,
  CollectionTransformed,
  Engine,
  EngineConfig,
  Entry,
} from "./types";

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

async function loadConfig(configPath: string): Promise<EngineConfig> {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(configPath);
  const mod = await jiti.import(configPath);
  return ((mod as any).default ?? mod) as EngineConfig;
}

async function initEngine(cwd = process.cwd()): Promise<Engine> {
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

export function setRuntimeConfig(config: EngineConfig): void {
  const store = getStore();
  store.config = config;
  store.engine = null;
  store.promise = null;
}

export async function getRuntimeEngine(cwd?: string): Promise<Engine> {
  return initEngine(cwd);
}

export function invalidateRuntimeEngine(): void {
  const store = getStore();
  store.engine = null;
  store.promise = null;
  store.config = null;
}

// Type-safe API with overloads
export async function getEntry<K extends keyof CollectionRegistry>(
  collection: K,
  slug: string
): Promise<Entry<CollectionData<K>, CollectionTransformed<K>> | undefined>;
export async function getEntry(
  collection: string,
  slug: string
): Promise<Entry | undefined>;
export async function getEntry(
  collection: string,
  slug: string
): Promise<Entry | undefined> {
  const engine = await initEngine();
  return engine.getEntry(collection, slug);
}

export async function getCollection<K extends keyof CollectionRegistry>(
  name: K
): Promise<Entry<CollectionData<K>, CollectionTransformed<K>>[]>;
export async function getCollection(name: string): Promise<Entry[]>;
export async function getCollection(name: string): Promise<Entry[]> {
  const engine = await initEngine();
  return engine.getCollection(name);
}

export async function getCollections(): Promise<Collection[]> {
  const engine = await initEngine();
  return engine.getCollections();
}
```

### `packages/core/src/index.ts` (Update)

```typescript
// Config
export { resolveConfig, resolveConfigFile, CONFIG_FILE_NAMES } from "./config";
export type { ResolvedConfig, ResolvedConfigFile } from "./config";

// Pipeline stages
export { collect, collectOne } from "./collector";
export type { CollectedFile } from "./collector";

export { parse, parseOne } from "./parser";
export type { ParsedDocument, ParseResult } from "./parser";

export { transform } from "./transformer";
export type { TransformResult, TransformOptions } from "./transformer";

export { write } from "./writer";
export type { WriteResult, WriteOptions } from "./writer";

// Pipeline
export { runPipeline, pipeline } from "./pipeline";
export type { PipelineResult, PipelineOptions } from "./pipeline";

// Synchronizer
export { createSynchronizer } from "./synchronizer";
export type { Synchronizer, SyncState, SyncResult } from "./synchronizer";

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

// Type generation
export { generateTypes, generate } from "./typegen";
export type { GeneratedOutput } from "./typegen";

// Context
export { createContextStore, createTransformContext, SkipDocumentError } from "./context";
export type { ContextStore } from "./context";

// Types
export {
  defineCollection,
  defineConfig,
  ValidationError,
  TransformError,
} from "./types";

export type {
  AnyCollection,
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
} from "./types";
```

## Tests

See individual test files for each component. Integration tests should verify:
- Engine scans and provides data
- Watch mode triggers callbacks
- Runtime API auto-initializes
- Type-safe API works with CollectionRegistry

## Acceptance Criteria

- [ ] Engine uses pipeline internally
- [ ] Engine uses synchronizer for state
- [ ] Watch mode works
- [ ] Runtime API auto-initializes
- [ ] Type-safe overloads work
- [ ] All existing functionality preserved
- [ ] All tests pass
