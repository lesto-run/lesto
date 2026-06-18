/// <reference lib="dom" />

/**
 * Search index loading (runtime, browser-safe).
 *
 * Extracted from the React hook so the loaders can be unit-tested directly
 * (a `.tsx` cannot be imported by tsc without `--jsx`). The hook in react.tsx
 * is the only public consumer.
 */

import { createCache, CACHE_LIMITS, CACHE_TTL } from "@lesto/content-shared/cache";
import { binaryQuantize } from "./binary";

// ============================================================================
// Index Types
// ============================================================================

interface CompactEntry {
  i: string;
  s: string;
  c: string;
  t: string;
  n: string;
  e: string;
  b?: string;
}

interface IndexV1 {
  v: 1;
  d: number;
  m: string;
  b: string;
  e: CompactEntry[];
}

interface CompactTier0 {
  v: 0;
  b: string;
  e: Array<{
    i: string;
    s: string;
    c: string;
    t: string;
    n: string;
    k: string[];
  }>;
}

interface CompactTier1 {
  v: 1;
  m: string;
  d: number;
  b: string;
  bs: number;
  e: Array<{
    i: string;
    s: string;
    c: string;
    t: string;
    n: string;
    be: string;
  }>;
}

export interface LoadedEntry {
  id: string;
  slug: string;
  collection: string;
  title: string;
  snippet: string;
  keywords?: string[];
  embedding?: number[];
  binaryEmbedding?: Uint8Array;
}

export interface LoadedIndex {
  entries: LoadedEntry[];
  dimensions: number;
  model: string;
  hasBinaryEmbeddings: boolean;
  hasKeywords: boolean;
  tier: 0 | 1 | "full";
}

// ============================================================================
// Index Loading
// ============================================================================

// Use shared LRU cache for search indexes (memory-heavy, limited to 10)
const indexCache = createCache<Promise<LoadedIndex>>({
  max: CACHE_LIMITS.SEARCH_INDEX,
  ttl: CACHE_TTL.LONG,
});

/** Test-only: reset the module-level index cache between cases. */
export function resetIndexCacheForTests(): void {
  indexCache.clear();
}

function decodeFloat32(encoded: string): number[] {
  const binaryString = atob(encoded);
  const bytes = Uint8Array.from(binaryString, (c) => c.charCodeAt(0));
  const alignedBuffer = new ArrayBuffer(bytes.length);
  new Uint8Array(alignedBuffer).set(bytes);
  return Array.from(new Float32Array(alignedBuffer));
}

function decodeUint8(encoded: string): Uint8Array {
  const binaryString = atob(encoded);
  return Uint8Array.from(binaryString, (c) => c.charCodeAt(0));
}

export async function loadTier0Index(tier0Path: string): Promise<LoadedIndex> {
  const response = await fetch(tier0Path);
  if (!response.ok) {
    throw new Error(`Failed to load Tier 0 index: ${response.status}`);
  }

  const data = (await response.json()) as CompactTier0;

  if (data.v !== 0) {
    throw new Error(`Unsupported Tier 0 index version: ${data.v}`);
  }

  const entries: LoadedEntry[] = data.e.map((e) => ({
    id: e.i,
    slug: e.s,
    collection: e.c,
    title: e.t,
    snippet: e.n,
    keywords: e.k,
  }));

  return {
    entries,
    dimensions: 384,
    model: "unknown",
    hasBinaryEmbeddings: false,
    hasKeywords: true,
    tier: 0,
  };
}

export async function loadTier1Index(
  tier1Path: string,
  existingEntries: LoadedEntry[],
): Promise<LoadedIndex> {
  const response = await fetch(tier1Path);
  if (!response.ok) {
    throw new Error(`Failed to load Tier 1 index: ${response.status}`);
  }

  const data = (await response.json()) as CompactTier1;

  if (data.v !== 1) {
    throw new Error(`Unsupported Tier 1 index version: ${data.v}`);
  }

  const entryMap = new Map(existingEntries.map((e) => [e.id, e]));

  for (const e of data.e) {
    const existing = entryMap.get(e.i);
    if (existing) {
      existing.binaryEmbedding = decodeUint8(e.be);
    } else {
      entryMap.set(e.i, {
        id: e.i,
        slug: e.s,
        collection: e.c,
        title: e.t,
        snippet: e.n,
        binaryEmbedding: decodeUint8(e.be),
      });
    }
  }

  return {
    entries: Array.from(entryMap.values()),
    dimensions: data.d,
    model: data.m,
    hasBinaryEmbeddings: true,
    hasKeywords: existingEntries.some((e) => e.keywords),
    tier: 1,
  };
}

/**
 * Load a search index, deduping concurrent loads via an LRU cache.
 *
 * Rejected loads are evicted so a transient failure can be retried instead of
 * being served from cache for the full TTL.
 */
export async function loadIndex(indexPath: string): Promise<LoadedIndex> {
  const cached = indexCache.get(indexPath);
  if (cached) return cached;

  const promise = (async () => {
    const response = await fetch(indexPath);
    if (!response.ok) {
      throw new Error(`Failed to load search index: ${response.status}`);
    }

    const json: unknown = await response.json();

    if (
      json &&
      typeof json === "object" &&
      "v" in json &&
      (json as Record<string, unknown>)["v"] === 1
    ) {
      const data = json as IndexV1;
      const hasBinary = data.e.some((e) => e.b);

      const entries: LoadedEntry[] = data.e.map((e) => {
        const entry: LoadedEntry = {
          id: e.i,
          slug: e.s,
          collection: e.c,
          title: e.t,
          snippet: e.n,
        };

        if (e.b) {
          entry.binaryEmbedding = decodeUint8(e.b);
        } else if (e.e) {
          entry.embedding = decodeFloat32(e.e);
          entry.binaryEmbedding = binaryQuantize(entry.embedding);
        }

        return entry;
      });

      return {
        entries,
        dimensions: data.d,
        model: data.m,
        hasBinaryEmbeddings: hasBinary || entries.some((e) => e.binaryEmbedding),
        hasKeywords: false,
        tier: "full" as const,
      };
    }

    const rawData = json as Record<string, unknown>;
    return {
      entries: (rawData["entries"] as LoadedEntry[]) || [],
      dimensions: (rawData["dimensions"] as number) || 384,
      model: (rawData["model"] as string) || "unknown",
      hasBinaryEmbeddings: false,
      hasKeywords: false,
      tier: "full" as const,
    };
  })();

  // Cache the in-flight promise so concurrent callers dedupe onto one fetch.
  // But NEVER let a rejection stick: a cached rejected promise would poison
  // every retry for the full TTL (CACHE_TTL.LONG ~ 24h). Evict on failure so
  // a transient error (network blip, 5xx, bad JSON) can be retried.
  indexCache.set(indexPath, promise);
  promise.catch(() => {
    // Only evict if this exact promise is still cached; a newer successful
    // load for the same path must not be clobbered.
    if (indexCache.get(indexPath) === promise) {
      indexCache.delete(indexPath);
    }
  });
  return promise;
}
