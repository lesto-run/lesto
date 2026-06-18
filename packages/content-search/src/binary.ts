/**
 * Binary Embedding Search (Runtime)
 *
 * Fast search using binary-quantized embeddings and Hamming distance.
 * This module contains RUNTIME functions for parsing and searching binary indexes.
 * BUILD-TIME functions (quantization, serialization) are in @lesto/content-embeddings.
 */

import { hammingDistance } from "@lesto/content-shared/encoding";
import type { SearchResult, SearchOptions, BinarySearchIndex } from "./types";
import { cosineSimilarity } from "./similarity";

// ============================================================================
// Binary Quantization (also needed at runtime for query vectors)
// ============================================================================

/**
 * Quantize a float32 embedding to a binary signature.
 * Each dimension becomes 1 bit: positive values -> 1, negative/zero -> 0.
 *
 * @param embedding - Float32 embedding array (384 dimensions)
 * @returns Uint8Array binary signature (48 bytes for 384-dim)
 */
export function binaryQuantize(embedding: number[]): Uint8Array {
  const numBytes = Math.ceil(embedding.length / 8);
  const bits = new Uint8Array(numBytes);

  for (let i = 0; i < embedding.length; i++) {
    const val = embedding[i];
    if (val !== undefined && val > 0) {
      const byteIdx = i >> 3;
      const existingByte = bits[byteIdx];
      if (existingByte !== undefined) {
        bits[byteIdx] = existingByte | (1 << (i & 7));
      }
    }
  }

  return bits;
}

// ============================================================================
// Hamming Distance
// ============================================================================

// hammingDistance lives in @lesto/content-shared/encoding (byte-identical
// algorithm). Re-exported here so existing importers of this module keep
// working unchanged.
export { hammingDistance };

/**
 * Convert Hamming distance to a similarity score (0-1).
 *
 * @param distance - Hamming distance
 * @param dimensions - Total bit dimensions (default: 384)
 * @returns Similarity score (0-1), or 0 if dimensions is 0
 */
export function hammingToSimilarity(distance: number, dimensions = 384): number {
  if (dimensions <= 0) return 0;
  return 1 - distance / dimensions;
}

/**
 * Convert a similarity threshold (0-1) to maximum Hamming distance.
 *
 * @param threshold - Similarity threshold (0-1)
 * @param dimensions - Total bit dimensions (default: 384)
 * @returns Maximum Hamming distance for threshold
 */
export function thresholdToHamming(threshold: number, dimensions = 384): number {
  return Math.floor((1 - threshold) * dimensions);
}

// ============================================================================
// Binary Index Parsing
// ============================================================================

interface CompactBinaryEntry {
  i: string;
  s: string;
  c: string;
  t: string;
  n: string;
  /** full embedding (base64 float32) — present in v2, omitted in v3 binary-only */
  e?: string;
  b: string;
}

interface CompactBinaryIndex {
  /** 2 = full + binary (rerankable); 3 = binary-only (no full embeddings) */
  v: 2 | 3;
  m: string;
  d: number;
  b: string;
  bs: number;
  e: CompactBinaryEntry[];
}

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
 * Decode a base64 string to float32 array.
 */
function decodeEmbedding(encoded: string): number[] {
  const bytes = decodeBytes(encoded);
  const alignedBuffer = new ArrayBuffer(bytes.length);
  new Uint8Array(alignedBuffer).set(bytes);
  return Array.from(new Float32Array(alignedBuffer));
}

/**
 * Validate and type-guard for CompactBinaryIndex.
 */
function isCompactBinaryIndex(data: unknown): data is CompactBinaryIndex {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    // v2 carries full embeddings (rerankable); v3 is binary-only.
    (obj["v"] === 2 || obj["v"] === 3) &&
    typeof obj["m"] === "string" &&
    typeof obj["d"] === "number" &&
    typeof obj["b"] === "string" &&
    typeof obj["bs"] === "number" &&
    Array.isArray(obj["e"])
  );
}

/**
 * Parse a binary search index from JSON string.
 *
 * @param json - JSON string from serializeBinaryIndex()
 * @returns BinarySearchIndex
 */
export function parseBinaryIndex(json: string): BinarySearchIndex {
  const parsed: unknown = JSON.parse(json);

  if (!isCompactBinaryIndex(parsed)) {
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["v"]
        : undefined;
    throw new Error(
      version !== undefined
        ? `Unsupported binary index version: ${version}`
        : "Invalid binary index format",
    );
  }

  return {
    entries: parsed.e.map((entry) => ({
      id: entry.i,
      slug: entry.s,
      collection: entry.c,
      title: entry.t,
      snippet: entry.n,
      // v3 (binary-only) carries no full embedding; only Hamming search is
      // possible, so leave it empty rather than fabricate values. hybridSearch
      // reranks via cosineSimilarity and will score these 0 — callers using a
      // binary-only index should use binarySearch, not hybridSearch.
      embedding: entry.e !== undefined ? decodeEmbedding(entry.e) : [],
      binaryEmbedding: decodeBytes(entry.b),
    })),
    dimensions: parsed.d,
    model: parsed.m,
    builtAt: parsed.b,
    binarySize: parsed.bs,
  };
}

/**
 * Load a binary index from URL.
 */
export async function loadBinaryIndex(url: string): Promise<BinarySearchIndex> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load binary index: ${response.status}`);
  }
  const json = await response.text();
  return parseBinaryIndex(json);
}

// ============================================================================
// Binary Search Functions
// ============================================================================

/**
 * Fast binary search using Hamming distance.
 *
 * @param queryEmbedding - Float32 query embedding
 * @param index - Binary search index
 * @param options - Search options
 * @returns Search results sorted by similarity
 */
export function binarySearch(
  queryEmbedding: number[],
  index: BinarySearchIndex,
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

/**
 * Hybrid search: Binary for candidate retrieval, full precision for reranking.
 *
 * @param queryEmbedding - Float32 query embedding
 * @param index - Binary search index
 * @param options - Search options
 * @returns Search results with accurate cosine similarity scores
 */
export function hybridSearch(
  queryEmbedding: number[],
  index: BinarySearchIndex,
  options: SearchOptions = {},
): SearchResult[] {
  const { collections, limit = 10, threshold = 0.3 } = options;

  const queryBinary = binaryQuantize(queryEmbedding);
  const candidateThreshold = Math.max(0.1, threshold - 0.2);
  const maxDistance = thresholdToHamming(candidateThreshold, index.dimensions);
  const candidateLimit = limit * 3;

  const candidates = collections
    ? index.entries.filter((e) => collections.includes(e.collection))
    : index.entries;

  // Fast candidate retrieval
  const binaryCandidates = candidates
    .map((entry) => ({
      entry,
      distance: hammingDistance(queryBinary, entry.binaryEmbedding),
    }))
    .filter(({ distance }) => distance <= maxDistance)
    .toSorted((a, b) => a.distance - b.distance)
    .slice(0, candidateLimit);

  // Rerank with full precision
  const reranked = binaryCandidates.map(({ entry }) => ({
    entry,
    score: cosineSimilarity(queryEmbedding, entry.embedding),
  }));

  return reranked
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
