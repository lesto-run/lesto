import path from "node:path";
import picomatch from "picomatch";
import type { AnyCollection, RuntimeEntry } from "./types";
import { ValidationError, TransformError } from "./types";
import type { ResolvedConfig } from "./config";
import { parseOne } from "./parser";
import { transform } from "./transformer";
import { SkipDocumentError } from "./context";

/** Errors that mean a document was intentionally skipped or failed validation, not a fatal sync error. */
function isSkippableError(error: unknown): boolean {
  return (
    error instanceof ValidationError ||
    error instanceof TransformError ||
    error instanceof SkipDocumentError
  );
}

export interface SyncState {
  entries: Map<string, RuntimeEntry>;
  pathToId: Map<string, string>;
  byCollection: Map<string, RuntimeEntry[]>;
}

export interface SyncResult {
  type: "added" | "changed" | "deleted" | "skipped";
  entry?: RuntimeEntry | undefined;
  path: string;
  collection: string;
}

interface CollectionMatcher {
  collection: AnyCollection;
  baseDir: string;
  isMatch: (path: string) => boolean;
}

export function createSynchronizer(config: ResolvedConfig) {
  const state: SyncState = {
    entries: new Map(),
    pathToId: new Map(),
    byCollection: new Map(),
  };

  const matchers: CollectionMatcher[] = config.collections.map((collection) => {
    const baseDir = path.isAbsolute(collection.directory)
      ? collection.directory
      : path.join(config.cwd, collection.directory);

    const include = Array.isArray(collection.include)
      ? collection.include
      : [collection.include ?? "**/*.md"];

    const exclude = Array.isArray(collection.exclude)
      ? collection.exclude
      : collection.exclude
        ? [collection.exclude]
        : [];

    return {
      collection,
      baseDir,
      isMatch: picomatch(include, { ignore: exclude }),
    };
  });

  function findCollection(absolutePath: string): CollectionMatcher | null {
    for (const matcher of matchers) {
      if (absolutePath.startsWith(matcher.baseDir + path.sep)) {
        const relativePath = path.relative(matcher.baseDir, absolutePath);
        if (matcher.isMatch(relativePath)) {
          return matcher;
        }
      }
    }
    return null;
  }

  function initialize(entries: RuntimeEntry[], pathMap: Map<string, string>): void {
    state.entries.clear();
    state.pathToId.clear();
    state.byCollection.clear();

    for (const entry of entries) {
      state.entries.set(entry.id, entry);

      let collectionEntries = state.byCollection.get(entry.collection);
      if (!collectionEntries) {
        collectionEntries = [];
        state.byCollection.set(entry.collection, collectionEntries);
      }
      collectionEntries.push(entry);
    }

    for (const [filePath, entryId] of pathMap) {
      state.pathToId.set(filePath, entryId);
    }
  }

  function deleted(absolutePath: string): SyncResult | null {
    const matcher = findCollection(absolutePath);
    if (!matcher) return null;

    const entryId = state.pathToId.get(absolutePath);
    if (!entryId) {
      return { type: "skipped", path: absolutePath, collection: matcher.collection.name };
    }

    const entry = state.entries.get(entryId);
    state.entries.delete(entryId);
    state.pathToId.delete(absolutePath);

    const collectionEntries = state.byCollection.get(matcher.collection.name);
    if (collectionEntries) {
      const idx = collectionEntries.findIndex((e) => e.id === entryId);
      if (idx !== -1) collectionEntries.splice(idx, 1);
    }

    return { type: "deleted", entry, path: absolutePath, collection: matcher.collection.name };
  }

  function removeOldEntry(absolutePath: string): void {
    const oldId = state.pathToId.get(absolutePath);
    if (oldId) {
      state.entries.delete(oldId);
      state.pathToId.delete(absolutePath);
    }
  }

  function handleIdChange(existingId: string | undefined, entry: RuntimeEntry, collectionName: string): void {
    if (existingId && existingId !== entry.id) {
      state.entries.delete(existingId);
      const oldEntries = state.byCollection.get(collectionName);
      if (oldEntries) {
        const idx = oldEntries.findIndex((e) => e.id === existingId);
        if (idx !== -1) oldEntries.splice(idx, 1);
      }
    }
  }

  function updateCollectionEntries(entry: RuntimeEntry, collectionName: string): void {
    let collectionEntries = state.byCollection.get(collectionName);
    if (!collectionEntries) {
      collectionEntries = [];
      state.byCollection.set(collectionName, collectionEntries);
    }
    const existingIdx = collectionEntries.findIndex((e) => e.id === entry.id);
    if (existingIdx !== -1) {
      collectionEntries[existingIdx] = entry;
    } else {
      collectionEntries.push(entry);
    }
  }

  async function changed(absolutePath: string): Promise<SyncResult | null> {
    const matcher = findCollection(absolutePath);
    if (!matcher) return null;

    const relativePath = path.relative(matcher.baseDir, absolutePath);

    try {
      const parsed = await parseOne({
        absolutePath,
        relativePath,
        collection: matcher.collection,
      });

      const result = await transform([parsed], config);
      const entry = result.entries[0];

      if (!entry) {
        removeOldEntry(absolutePath);
        return { type: "skipped", path: absolutePath, collection: matcher.collection.name };
      }

      const existingId = state.pathToId.get(absolutePath);
      const isNew = !existingId;

      handleIdChange(existingId, entry, matcher.collection.name);

      state.entries.set(entry.id, entry);
      state.pathToId.set(absolutePath, entry.id);

      updateCollectionEntries(entry, matcher.collection.name);

      return {
        type: isNew ? "added" : "changed",
        entry,
        path: absolutePath,
        collection: matcher.collection.name,
      };
    } catch (error) {
      if (isSkippableError(error)) {
        return { type: "skipped", path: absolutePath, collection: matcher.collection.name };
      }
      throw error;
    }
  }

  return {
    initialize,
    deleted,
    changed,
    getState: () => state,
    getEntries: () => Array.from(state.entries.values()),
    getCollection: (name: string) => state.byCollection.get(name) ?? [],
    getEntry: (collection: string, slug: string) => state.entries.get(`${collection}/${slug}`),
  };
}

export type Synchronizer = ReturnType<typeof createSynchronizer>;
