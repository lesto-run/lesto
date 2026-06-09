import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { ResolvedConfig } from "./config";
import { runPipeline } from "./pipeline";
import { createSynchronizer, type Synchronizer } from "./synchronizer";
import { generateTypes } from "./typegen";
import type { Collection, EngineConfig, Engine, WatchCallback, WatchEvent } from "./types";
import type { AnyTaxonomy } from "./taxonomy";
import { setTaxonomies } from "./runtime";

export function createEngine(config: EngineConfig): Engine {
  const cwd = config.cwd ?? process.cwd();

  let resolvedConfig: ResolvedConfig | null = null;
  let synchronizer: Synchronizer | null = null;
  let watcher: FSWatcher | null = null;
  const watchCallbacks = new Set<WatchCallback>();

  return {
    async scan() {
      const result = await runPipeline({
        cwd,
        config,
        skipWrite: true,
        ...(config.cache !== undefined && { cache: config.cache }),
      });

      resolvedConfig = result.config;
      const taxonomyRecord: Record<string, AnyTaxonomy> = {};
      for (const taxonomy of result.config.taxonomies) {
        taxonomyRecord[taxonomy.name] = taxonomy;
      }
      setTaxonomies(taxonomyRecord);

      // Initialize synchronizer with results
      synchronizer = createSynchronizer(result.config);

      // Build path map from files
      const pathMap = new Map<string, string>();
      for (const file of result.files) {
        const entry = result.entries.find(
          (e) => e.collection === file.collection.name && e.file.path === file.relativePath,
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
          path.isAbsolute(col.directory) ? col.directory : path.join(cwd, col.directory),
        );

        watcher = chokidarWatch(watchPaths, {
          ignoreInitial: true,
          ignored: ["**/node_modules/**"],
        });

        watcher.on("add", async (filePath: string) => {
          if (!synchronizer) return;
          const result = await synchronizer.changed(filePath);
          if (result && result.entry) {
            const event: WatchEvent = {
              type: "add",
              path: filePath,
              collection: result.collection,
              entry: result.entry,
            };
            for (const cb of watchCallbacks) cb(event);
          }
        });

        watcher.on("change", async (filePath: string) => {
          if (!synchronizer) return;
          const result = await synchronizer.changed(filePath);
          if (result && result.entry) {
            const event: WatchEvent = {
              type: "change",
              path: filePath,
              collection: result.collection,
              entry: result.entry,
            };
            for (const cb of watchCallbacks) cb(event);
          }
        });

        watcher.on("unlink", (filePath: string) => {
          if (!synchronizer) return;
          const result = synchronizer.deleted(filePath);
          if (result && result.entry) {
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
      return generateTypes(resolvedConfig.collections, resolvedConfig.taxonomies);
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
