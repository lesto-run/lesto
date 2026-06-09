/**
 * Binary Embedding Quantization (Build-time)
 *
 * Reduces 384-dim float32 embeddings (1536 bytes) to binary signatures (48 bytes)
 * with <5% recall loss. Uses Hamming distance for 50x faster similarity computation.
 *
 * This module contains BUILD-TIME functions for creating and serializing binary indexes.
 * RUNTIME functions (Hamming search, parsing) are in @keel/content-search.
 */

import { encodeBase64 } from "@keel/content-shared/encoding";
import type { EmbeddingResult, BinaryEmbeddingResult, BinarySearchIndex } from "./types";
import { MODEL_NAME, EMBEDDING_DIMENSIONS } from "./constants";

// ============================================================================
// Binary Quantization
// ============================================================================

/**
 * Quantize a float32 embedding to a binary signature.
 * Each dimension becomes 1 bit: positive values -> 1, negative/zero -> 0.
 *
 * For 384-dim embeddings: 384 bits = 48 bytes (32x compression from 1536 bytes).
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

/**
 * Dequantize a binary signature back to approximate float values.
 * Useful for understanding quantization effects but not for production search.
 *
 * @param bits - Binary signature
 * @param dimensions - Original embedding dimensions (default: 384)
 * @returns Approximate float32 embedding (-1 or +1 values)
 */
export function binaryDequantize(bits: Uint8Array, dimensions = EMBEDDING_DIMENSIONS): number[] {
  return Array.from({ length: dimensions }, (_, i) => {
    const byte = bits[i >> 3]!;
    const bit = (byte >> (i & 7)) & 1;
    return bit ? 1 : -1;
  });
}

// ============================================================================
// Binary Index Creation
// ============================================================================

/**
 * Add binary embeddings to existing embedding results.
 *
 * @param entries - Embedding results from generateEmbeddings()
 * @returns Entries with binary embeddings added
 */
export function addBinaryEmbeddings(entries: EmbeddingResult[]): BinaryEmbeddingResult[] {
  return entries.map((entry) => ({
    ...entry,
    binaryEmbedding: binaryQuantize(entry.embedding),
  }));
}

/**
 * Create a binary search index from embedding results.
 *
 * @param entries - Embedding results from generateEmbeddings()
 * @returns Binary search index
 */
export function createBinaryIndex(entries: EmbeddingResult[]): BinarySearchIndex {
  const binaryEntries = addBinaryEmbeddings(entries);
  const dimensions = entries[0]?.embedding.length ?? EMBEDDING_DIMENSIONS;

  return {
    entries: binaryEntries,
    dimensions,
    model: MODEL_NAME,
    builtAt: new Date().toISOString(),
    binarySize: Math.ceil(dimensions / 8),
  };
}

// ============================================================================
// Binary Index Serialization
// ============================================================================

/**
 * Compact binary entry format for storage.
 */
interface CompactBinaryEntry {
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
  /** full embedding (base64-encoded float32 array) */
  e: string;
  /** binary embedding (base64-encoded) */
  b: string;
}

/**
 * Compact binary search index format.
 */
interface CompactBinaryIndex {
  /** version */
  v: 2;
  /** model */
  m: string;
  /** dimensions */
  d: number;
  /** built at timestamp */
  b: string;
  /** binary size in bytes */
  bs: number;
  /** entries */
  e: CompactBinaryEntry[];
}

/**
 * Encode a float32 array to base64 string.
 */
function encodeEmbedding(embedding: number[]): string {
  const buffer = new Float32Array(embedding).buffer;
  return encodeBase64(new Uint8Array(buffer));
}

/**
 * Serialize a binary search index to JSON string.
 *
 * @param index - Binary search index
 * @returns JSON string
 */
export function serializeBinaryIndex(index: BinarySearchIndex): string {
  const compact: CompactBinaryIndex = {
    v: 2,
    m: index.model,
    d: index.dimensions,
    b: index.builtAt,
    bs: index.binarySize,
    e: index.entries.map((entry) => ({
      i: entry.id,
      s: entry.slug,
      c: entry.collection,
      t: entry.title,
      n: entry.snippet,
      e: encodeEmbedding(entry.embedding),
      b: encodeBase64(entry.binaryEmbedding),
    })),
  };
  return JSON.stringify(compact);
}

/**
 * Serialize a binary-only index (no full embeddings).
 * Used when storage is constrained and full reranking isn't needed.
 *
 * This provides maximum compression: 48 bytes per entry vs 1536 bytes.
 *
 * @param index - Binary search index
 * @returns JSON string with only binary embeddings
 */
export function serializeBinaryOnlyIndex(index: BinarySearchIndex): string {
  const compact = {
    v: 3 as const,
    m: index.model,
    d: index.dimensions,
    b: index.builtAt,
    bs: index.binarySize,
    e: index.entries.map((entry) => ({
      i: entry.id,
      s: entry.slug,
      c: entry.collection,
      t: entry.title,
      n: entry.snippet,
      b: encodeBase64(entry.binaryEmbedding),
    })),
  };
  return JSON.stringify(compact);
}

/**
 * Estimate size savings from binary quantization.
 *
 * @param entryCount - Number of entries
 * @param dimensions - Embedding dimensions (default: 384)
 * @returns Size comparison
 */
export function estimateBinarySavings(
  entryCount: number,
  dimensions = EMBEDDING_DIMENSIONS
): {
  fullSizeBytes: number;
  binarySizeBytes: number;
  compressionRatio: number;
  savings: string;
} {
  const bytesPerFloat = 4;
  const fullSizeBytes = entryCount * dimensions * bytesPerFloat;
  const binarySizeBytes = entryCount * Math.ceil(dimensions / 8);
  const compressionRatio = fullSizeBytes / binarySizeBytes;

  return {
    fullSizeBytes,
    binarySizeBytes,
    compressionRatio,
    savings: `${Math.round((1 - binarySizeBytes / fullSizeBytes) * 100)}%`,
  };
}
