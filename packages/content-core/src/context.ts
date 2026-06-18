import type { AnyCollection, InferEntry, RuntimeEntry, TransformContext } from "./types";
import { createCache, CACHE_LIMITS, CACHE_TTL } from "@volo/content-shared/cache";

export class SkipDocumentError extends Error {
  constructor() {
    super("Document skipped via context.skip()");
    this.name = "SkipDocumentError";
  }
}

/**
 * Simple cache interface that matches both LRUCache and Map APIs.
 */
interface CacheStore {
  has(key: string): boolean;
  get(key: string): Promise<unknown> | undefined;
  set(key: string, value: Promise<unknown>): void;
}

export interface ContextStore {
  cache: CacheStore;
  collections: Map<string, RuntimeEntry[]>;
}

export function createContextStore(): ContextStore {
  return {
    cache: createCache<Promise<unknown>>({
      max: CACHE_LIMITS.TRANSFORM_CONTEXT,
      ttl: CACHE_TTL.MEDIUM,
    }),
    collections: new Map(),
  };
}

export function createTransformContext(
  collectionName: string,
  collectionDirectory: string,
  filePath: string,
  store: ContextStore,
): TransformContext {
  return {
    documents<T extends AnyCollection>(collection: T): InferEntry<T>[] {
      const entries = store.collections.get(collection.name);
      if (!entries) {
        throw new Error(
          `Collection "${collection.name}" not found. ` +
            `Ensure it appears before "${collectionName}" in your collections array.`,
        );
      }
      return entries as InferEntry<T>[];
    },

    async cache<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
      const cacheKey = `${collectionName}:${key}`;
      if (store.cache.has(cacheKey)) {
        // Cache stores Promise<unknown>, cast to Promise<T> (async function flattens the promise)
        return store.cache.get(cacheKey) as Promise<T>;
      }
      const promise = Promise.resolve().then(fn);
      store.cache.set(cacheKey, promise);
      return promise;
    },

    skip(): never {
      throw new SkipDocumentError();
    },

    collection: {
      name: collectionName,
      directory: collectionDirectory,
    },

    filePath,
  };
}
