/**
 * Progressive Search Index (Runtime)
 *
 * Functions for parsing and searching with 2-tier progressive indexes.
 * BUILD-TIME functions (generation, serialization) are in @lesto/content-embeddings.
 */

import type {
  Tier0Index,
  Tier1Index,
  CompactTier0Index,
  CompactTier1Index,
  SearchResult,
  SearchOptions,
} from "./types";
import { extractKeywords } from "@lesto/content-shared/text";
import { binaryQuantize, hammingDistance, hammingToSimilarity, thresholdToHamming } from "./binary";

// ============================================================================
// Parsing
// ============================================================================

/**
 * Decode a base64 string to Uint8Array.
 */
function decodeBytes(encoded: string): Uint8Array {
  if (typeof atob === "function") {
    return Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

/**
 * Parse Tier 0 index from JSON.
 */
export function parseTier0Index(json: string): Tier0Index {
  const compact = JSON.parse(json) as CompactTier0Index;

  if (compact.v !== 0) {
    throw new Error(`Unsupported Tier 0 index version: ${compact.v}`);
  }

  return {
    version: 0,
    builtAt: compact.b,
    entries: compact.e.map((entry) => ({
      id: entry.i,
      slug: entry.s,
      collection: entry.c,
      title: entry.t,
      snippet: entry.n,
      keywords: entry.k,
    })),
  };
}

/**
 * Parse Tier 1 index from JSON.
 */
export function parseTier1Index(json: string): Tier1Index {
  const compact = JSON.parse(json) as CompactTier1Index;

  if (compact.v !== 1) {
    throw new Error(`Unsupported Tier 1 index version: ${compact.v}`);
  }

  return {
    version: 1,
    dimensions: compact.d,
    model: compact.m,
    builtAt: compact.b,
    binarySize: compact.bs,
    entries: compact.e.map((entry) => ({
      id: entry.i,
      slug: entry.s,
      collection: entry.c,
      title: entry.t,
      snippet: entry.n,
      binaryEmbedding: decodeBytes(entry.be),
    })),
  };
}

/**
 * Load Tier 0 index from URL.
 */
export async function loadTier0Index(url: string): Promise<Tier0Index> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load Tier 0 index: ${response.status}`);
  }
  const json = await response.text();
  return parseTier0Index(json);
}

/**
 * Load Tier 1 index from URL.
 */
export async function loadTier1Index(url: string): Promise<Tier1Index> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load Tier 1 index: ${response.status}`);
  }
  const json = await response.text();
  return parseTier1Index(json);
}

// ============================================================================
// Keyword Search (Tier 0)
// ============================================================================

// extractKeywords (and its STOP_WORDS) now live in @lesto/content-shared/text,
// shared with the build-time index generator so the keywords stored in a Tier 0
// index always match those extracted from a live query. Re-exported here for
// existing importers of this module.
export { extractKeywords };

/**
 * Fast keyword search using Tier 0 index.
 */
export function keywordSearch(
  query: string,
  index: Tier0Index,
  options: SearchOptions = {},
): SearchResult[] {
  const { collections, limit = 10, threshold = 0.1 } = options;

  const queryKeywords = new Set(extractKeywords(query));
  if (queryKeywords.size === 0) return [];

  const candidates = collections
    ? index.entries.filter((e) => collections.includes(e.collection))
    : index.entries;

  const scored = candidates.map((entry) => {
    const matches = entry.keywords.filter((k) => queryKeywords.has(k)).length;
    const titleLower = entry.title.toLowerCase();
    const titleMatch = [...queryKeywords].some((k) => titleLower.includes(k)) ? 0.3 : 0;
    const keywordScore = queryKeywords.size > 0 ? matches / queryKeywords.size : 0;
    const score = Math.min(1, keywordScore * 0.7 + titleMatch);

    return { entry, score };
  });

  return scored
    .filter(({ score }) => score >= threshold)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry, score }) => ({
      id: entry.id,
      slug: entry.slug,
      collection: entry.collection,
      title: entry.title,
      snippet: entry.snippet,
      score,
    }));
}

// ============================================================================
// Binary Semantic Search (Tier 1)
// ============================================================================

/**
 * Fast binary semantic search using Tier 1 index.
 */
export function binarySemanticSearch(
  queryEmbedding: number[],
  index: Tier1Index,
  options: SearchOptions = {},
): SearchResult[] {
  const { collections, limit = 10, threshold = 0.3 } = options;

  const queryBinary = binaryQuantize(queryEmbedding);
  const maxDistance = thresholdToHamming(threshold, index.dimensions);

  const candidates = collections
    ? index.entries.filter((e) => collections.includes(e.collection))
    : index.entries;

  const scored = candidates.map((entry) => ({
    entry,
    distance: hammingDistance(queryBinary, entry.binaryEmbedding),
  }));

  return scored
    .filter(({ distance }) => distance <= maxDistance)
    .toSorted((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ entry, distance }) => ({
      id: entry.id,
      slug: entry.slug,
      collection: entry.collection,
      title: entry.title,
      snippet: entry.snippet,
      score: hammingToSimilarity(distance, index.dimensions),
    }));
}
