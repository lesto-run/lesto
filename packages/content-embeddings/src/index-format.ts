/**
 * JSON Search Index Format (Build-time)
 *
 * Stores embeddings in a compact JSON format for fast loading.
 * Designed for static hosting - no server-side processing required.
 *
 * This module contains BUILD-TIME functions for serializing indexes.
 * RUNTIME functions (parsing, loading) are in @keel/content-search.
 */

import { encodeBase64 } from "@keel/content-shared/encoding";
import type { EmbeddingResult, SearchIndex, GenerateSearchIndexOptions } from "./types";
import { MODEL_NAME, EMBEDDING_DIMENSIONS } from "./constants";

// ============================================================================
// Types
// ============================================================================

/**
 * Compact entry format for storage.
 * Minimizes JSON size by using short property names.
 */
interface CompactEntry {
  /** id */
  i: string;
  /** slug */
  s: string;
  /** collection */
  c: string;
  /** title */
  t: string;
  /** snippet */
  n: string;
  /** embedding (base64-encoded float32 array) */
  e: string;
}

/**
 * Compact search index format.
 */
interface CompactSearchIndex {
  /** version */
  v: 1;
  /** model */
  m: string;
  /** dimensions */
  d: number;
  /** built at timestamp */
  b: string;
  /** entries */
  e: CompactEntry[];
}

// ============================================================================
// Encoding
// ============================================================================

/**
 * Encode a float32 array to base64 string.
 * More compact than JSON array of numbers.
 */
function encodeEmbedding(embedding: number[]): string {
  const buffer = new Float32Array(embedding).buffer;
  return encodeBase64(new Uint8Array(buffer));
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Convert EmbeddingResult to compact format.
 */
function toCompactEntry(entry: EmbeddingResult): CompactEntry {
  return {
    i: entry.id,
    s: entry.slug,
    c: entry.collection,
    t: entry.title,
    n: entry.snippet,
    e: encodeEmbedding(entry.embedding),
  };
}

/**
 * Serialize embedding results to JSON string.
 *
 * Uses compact format by default to minimize file size:
 * - Short property names (i, s, c, t, n, e)
 * - Base64-encoded embeddings (vs JSON arrays)
 *
 * @param entries - Embedding results from generateEmbeddings()
 * @param options - Serialization options
 * @returns JSON string
 */
export function serializeSearchIndex(
  entries: EmbeddingResult[],
  options: GenerateSearchIndexOptions = {},
): string {
  const { model = MODEL_NAME, compact = true } = options;

  if (compact) {
    const index: CompactSearchIndex = {
      v: 1,
      m: model,
      d: entries[0]?.embedding.length ?? EMBEDDING_DIMENSIONS,
      b: new Date().toISOString(),
      e: entries.map(toCompactEntry),
    };
    return JSON.stringify(index);
  }

  // Non-compact format for debugging
  const index: SearchIndex = {
    entries,
    dimensions: entries[0]?.embedding.length ?? EMBEDDING_DIMENSIONS,
    model,
    builtAt: new Date().toISOString(),
  };
  return JSON.stringify(index, null, 2);
}

/**
 * Estimate the size of a search index in bytes.
 * Useful for understanding index overhead.
 */
export function estimateIndexSize(entries: EmbeddingResult[]): {
  compact: number;
  regular: number;
  savings: number;
} {
  // Estimate compact size
  // Each embedding: 384 floats x 4 bytes = 1536 bytes -> ~2048 chars base64
  // Plus metadata: ~100 bytes per entry
  const compactPerEntry = 2048 + 100;
  const compactTotal = entries.length * compactPerEntry + 100; // +100 for header

  // Estimate regular size
  // Each float as JSON: ~10 chars average (e.g., "0.12345678")
  // 384 floats x 10 chars = 3840 chars
  // Plus metadata: ~150 bytes per entry
  const regularPerEntry = 3840 + 150;
  const regularTotal = entries.length * regularPerEntry + 200; // +200 for header

  return {
    compact: compactTotal,
    regular: regularTotal,
    savings: Math.round((1 - compactTotal / regularTotal) * 100),
  };
}
