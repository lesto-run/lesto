import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import type {
  CacheManifest,
  CachedParseResult,
  CachedTransformResult,
  CacheOptions,
  CacheStats,
  CollectionCacheMeta,
} from "./types";
import { CACHE_VERSION } from "./types";
import { initHasher, hashString, hashObject, hashFunction } from "./hash";
import type { AnyCollection } from "../types";

const DEFAULT_CACHE_DIR = ".docks/cache";
const CORE_VERSION = "0.1.0";
const DEFAULT_MAX_ENTRIES = 10000; // Max entries per cache Map to prevent unbounded growth

export interface CacheManager {
  init(): Promise<void>;
  /** Get cached parse result by content hash. Content hash is the source of truth. */
  getParseCache(
    collection: string,
    filePath: string,
    contentHash: string,
  ): CachedParseResult | null;
  setParseCache(collection: string, filePath: string, result: CachedParseResult): void;
  getTransformCache(
    collection: string,
    entryId: string,
    parseHash: string,
  ): CachedTransformResult | null;
  setTransformCache(collection: string, entryId: string, result: CachedTransformResult): void;
  flush(): Promise<void>;
  clear(): Promise<void>;
  getStats(): CacheStats;
  isEnabled(): boolean;
}

function enforceLimit<T>(cache: Map<string, T>, limit: number): void {
  if (cache.size <= limit) return;
  const toDelete = cache.size - limit;
  const keysToDelete: string[] = [];
  for (const key of cache.keys()) {
    keysToDelete.push(key);
    if (keysToDelete.length >= toDelete) break;
  }
  for (const key of keysToDelete) {
    cache.delete(key);
  }
}

async function computeCollectionMeta(collection: AnyCollection): Promise<CollectionCacheMeta> {
  const schemaHash = await hashObject(collection.schema);
  const transformHash = collection.transform ? await hashFunction(collection.transform) : null;
  const parserHash = await hashString(String(collection.parser ?? "frontmatter"));
  return { schemaHash, transformHash, parserHash, entryCount: 0 };
}

function isCollectionStale(
  meta: CollectionCacheMeta | undefined,
  newMeta: CollectionCacheMeta,
): boolean {
  if (!meta) return true;
  return (
    meta.schemaHash !== newMeta.schemaHash ||
    meta.transformHash !== newMeta.transformHash ||
    meta.parserHash !== newMeta.parserHash
  );
}

async function loadCacheFile<T>(filePath: string): Promise<Record<string, T> | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as Record<string, T>;
  } catch {
    return null;
  }
}

async function writeCacheEntries<T>(
  cache: Map<string, T>,
  collection: string,
  filePath: string,
): Promise<void> {
  const entries: Record<string, T> = {};
  const prefix = `${collection}:`;
  for (const [key, value] of cache) {
    if (key.startsWith(prefix)) {
      entries[key.slice(prefix.length)] = value;
    }
  }
  await writeFile(filePath, JSON.stringify(entries), "utf-8");
}

/** Clear cache entries for a specific collection */
function clearCollectionCache<T>(cache: Map<string, T>, collectionName: string): void {
  const prefix = `${collectionName}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

/** Load and populate cache entries from file into memory */
async function loadCacheIntoMap<T>(
  cacheDir: string,
  subdir: string,
  collectionName: string,
  cache: Map<string, T>,
): Promise<void> {
  const data = await loadCacheFile<T>(path.join(cacheDir, subdir, `${collectionName}.json`));
  if (!data) return;
  for (const [key, value] of Object.entries(data)) {
    cache.set(`${collectionName}:${key}`, value);
  }
}

/** Process a single collection for manifest initialization */
async function processCollectionForManifest(
  cacheDir: string,
  collection: AnyCollection,
  existingManifest: CacheManifest | null,
  parseCache: Map<string, CachedParseResult>,
  transformCache: Map<string, CachedTransformResult>,
): Promise<CollectionCacheMeta> {
  const newMeta = await computeCollectionMeta(collection);
  const oldMeta = existingManifest?.collections[collection.name];

  if (isCollectionStale(oldMeta, newMeta)) {
    clearCollectionCache(parseCache, collection.name);
    clearCollectionCache(transformCache, collection.name);
  } else {
    await loadCacheIntoMap(cacheDir, "parse", collection.name, parseCache);
    await loadCacheIntoMap(cacheDir, "transform", collection.name, transformCache);
  }

  return newMeta;
}

async function initializeManifest(
  cacheDir: string,
  collections: AnyCollection[],
  existingManifest: CacheManifest | null,
  parseCache: Map<string, CachedParseResult>,
  transformCache: Map<string, CachedTransformResult>,
): Promise<CacheManifest> {
  const collectionEntries = await Promise.all(
    collections.map(async (c) => {
      const meta = await processCollectionForManifest(
        cacheDir,
        c,
        existingManifest,
        parseCache,
        transformCache,
      );
      return [c.name, meta] as const;
    }),
  );

  return {
    version: CACHE_VERSION,
    coreVersion: CORE_VERSION,
    lastUpdated: Date.now(),
    configHash: await hashObject(collections.map((c) => c.name)),
    collections: Object.fromEntries(collectionEntries),
  };
}

/** Build cache file path for a collection */
function buildCachePath(cacheDir: string, subdir: string, collection: string): string {
  return path.join(cacheDir, subdir, `${collection}.json`);
}

/** Build cache key from collection and identifier */
function buildCacheKey(collection: string, id: string): string {
  return `${collection}:${id}`;
}

/** An active cache manager is always enabled. */
function cacheManagerEnabled(): boolean {
  return true;
}

export async function createCacheManager(
  cwd: string,
  collections: AnyCollection[],
  options: CacheOptions = {},
): Promise<CacheManager> {
  const enabled = options.enabled !== false;
  const cacheDir = options.cacheDir ?? path.join(cwd, DEFAULT_CACHE_DIR);

  if (!enabled) {
    return createNoopCacheManager();
  }

  await initHasher();

  let manifest: CacheManifest | null = null;
  const parseCache = new Map<string, CachedParseResult>();
  const transformCache = new Map<string, CachedTransformResult>();
  const stats: CacheStats = {
    parseHits: 0,
    parseMisses: 0,
    transformHits: 0,
    transformMisses: 0,
    timeSaved: 0,
  };

  const parseCacheDirty = new Set<string>();
  const transformCacheDirty = new Set<string>();
  let manifestDirty = false;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  async function init(): Promise<void> {
    if (options.clearCache) {
      await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    }

    await mkdir(path.join(cacheDir, "parse"), { recursive: true });
    await mkdir(path.join(cacheDir, "transform"), { recursive: true });

    const loadedManifest = (await loadCacheFile<CacheManifest>(
      path.join(cacheDir, "manifest.json"),
    )) as CacheManifest | null;

    let existingManifest = loadedManifest;
    if (existingManifest) {
      const cacheValid =
        existingManifest.version === CACHE_VERSION && existingManifest.coreVersion === CORE_VERSION;
      if (!cacheValid) {
        await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
        await mkdir(path.join(cacheDir, "parse"), { recursive: true });
        await mkdir(path.join(cacheDir, "transform"), { recursive: true });
        existingManifest = null;
      }
    }

    manifest = await initializeManifest(
      cacheDir,
      collections,
      existingManifest,
      parseCache,
      transformCache,
    );
    manifestDirty = true;
  }

  function getParseCache(
    collection: string,
    filePath: string,
    contentHash: string,
  ): CachedParseResult | null {
    const key = buildCacheKey(collection, filePath);
    const cached = parseCache.get(key);

    if (!cached) {
      stats.parseMisses++;
      return null;
    }

    if (cached.contentHash === contentHash) {
      stats.parseHits++;
      stats.timeSaved += 5;
      return cached;
    }

    stats.parseMisses++;
    return null;
  }

  function setParseCache(collection: string, filePath: string, result: CachedParseResult): void {
    const key = buildCacheKey(collection, filePath);
    parseCache.set(key, result);
    parseCacheDirty.add(collection);
    enforceLimit(parseCache, maxEntries);
  }

  function getTransformCache(
    collection: string,
    entryId: string,
    parseHash: string,
  ): CachedTransformResult | null {
    const key = buildCacheKey(collection, entryId);
    const cached = transformCache.get(key);

    if (!cached) {
      stats.transformMisses++;
      return null;
    }

    if (cached.parseHash !== parseHash) {
      stats.transformMisses++;
      return null;
    }

    stats.transformHits++;
    stats.timeSaved += 10;
    return cached;
  }

  function setTransformCache(
    collection: string,
    entryId: string,
    result: CachedTransformResult,
  ): void {
    const key = buildCacheKey(collection, entryId);
    transformCache.set(key, result);
    transformCacheDirty.add(collection);
    enforceLimit(transformCache, maxEntries);
  }

  function countEntriesForCollection(collectionName: string): number {
    const prefix = `${collectionName}:`;
    return [...parseCache.keys()].filter((key) => key.startsWith(prefix)).length;
  }

  function updateEntryCountsForDirtyCollections(): void {
    if (!manifest) return;
    for (const collectionName of parseCacheDirty) {
      const collectionMeta = manifest.collections[collectionName];
      if (collectionMeta) {
        collectionMeta.entryCount = countEntriesForCollection(collectionName);
      }
    }
  }

  async function flushDirtyCaches(): Promise<void> {
    const parseWrites = [...parseCacheDirty].map((collection) =>
      writeCacheEntries(parseCache, collection, buildCachePath(cacheDir, "parse", collection)),
    );
    const transformWrites = [...transformCacheDirty].map((collection) =>
      writeCacheEntries(
        transformCache,
        collection,
        buildCachePath(cacheDir, "transform", collection),
      ),
    );
    await Promise.all([...parseWrites, ...transformWrites]);
  }

  async function flush(): Promise<void> {
    if (!manifest) return;

    await flushDirtyCaches();

    const hasChanges = manifestDirty || parseCacheDirty.size > 0 || transformCacheDirty.size > 0;
    if (hasChanges) {
      manifest.lastUpdated = Date.now();
      updateEntryCountsForDirtyCollections();
      await writeFile(
        path.join(cacheDir, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf-8",
      );
    }

    parseCacheDirty.clear();
    transformCacheDirty.clear();
    manifestDirty = false;
  }

  async function clear(): Promise<void> {
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    parseCache.clear();
    transformCache.clear();
    manifest = null;
  }

  function getStats(): CacheStats {
    return { ...stats };
  }

  return {
    init,
    getParseCache,
    setParseCache,
    getTransformCache,
    setTransformCache,
    flush,
    clear,
    getStats,
    isEnabled: cacheManagerEnabled,
  };
}

function createNoopCacheManager(): CacheManager {
  const stats: CacheStats = {
    parseHits: 0,
    parseMisses: 0,
    transformHits: 0,
    transformMisses: 0,
    timeSaved: 0,
  };

  return {
    init: async () => {},
    getParseCache: () => null,
    setParseCache: () => {},
    getTransformCache: () => null,
    setTransformCache: () => {},
    flush: async () => {},
    clear: async () => {},
    getStats: () => stats,
    isEnabled: () => false,
  };
}
