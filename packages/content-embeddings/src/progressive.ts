/**
 * Progressive Search Index (2-Tier Architecture) - Build-time
 *
 * Tier 0: Metadata-only index for instant keyword search
 * - Preloaded via `<link rel="preload">`
 * - Enables keyword search immediately on page load
 * - ~50-100KB for typical docs
 *
 * Tier 1: Binary embeddings for fast semantic search
 * - Loaded in background after Tier 0
 * - 32x smaller than full float32 embeddings
 * - ~48 bytes per entry embedding
 *
 * This module contains BUILD-TIME functions for generating and serializing indexes.
 * RUNTIME functions (parsing, searching) are in @keel/content-search.
 */

import { encodeBase64 } from "@keel/content-shared/encoding";
import type {
  EmbeddingResult,
  Tier0Index,
  Tier0Entry,
  Tier1Index,
  Tier1Entry,
  CompactTier0Index,
  CompactTier1Index,
} from "./types";
import { extractKeywords } from "@keel/content-shared/text";
import { binaryQuantize } from "./binary";
import { MODEL_NAME, EMBEDDING_DIMENSIONS } from "./constants";

// ============================================================================
// Keyword Extraction
// ============================================================================

// extractKeywords (and its STOP_WORDS) now live in @keel/content-shared/text,
// shared with the runtime keyword search so build-time and query-time keyword
// extraction stay byte-identical. Its default cap (50) matches the former
// DEFAULT_MAX_KEYWORDS. Re-exported here for existing importers of this module.
export { extractKeywords };

// ============================================================================
// Index Generation
// ============================================================================

/**
 * Generate progressive (2-tier) search indexes from embedding results.
 *
 * @param entries - Embedding results from generateEmbeddings()
 * @returns Tier 0 (metadata-only) and Tier 1 (binary embeddings) indexes
 */
export function generateProgressiveIndex(entries: EmbeddingResult[]): {
  tier0: Tier0Index;
  tier1: Tier1Index;
} {
  const now = new Date().toISOString();
  const dimensions = entries[0]?.embedding.length ?? EMBEDDING_DIMENSIONS;

  // Generate Tier 0: Metadata + keywords only
  const tier0Entries: Tier0Entry[] = entries.map((entry) => ({
    id: entry.id,
    slug: entry.slug,
    collection: entry.collection,
    title: entry.title,
    snippet: entry.snippet,
    keywords: extractKeywords(`${entry.title} ${entry.snippet}`),
  }));

  // Generate Tier 1: Binary embeddings
  const tier1Entries: Tier1Entry[] = entries.map((entry) => ({
    id: entry.id,
    slug: entry.slug,
    collection: entry.collection,
    title: entry.title,
    snippet: entry.snippet,
    binaryEmbedding: binaryQuantize(entry.embedding),
  }));

  return {
    tier0: {
      version: 0,
      entries: tier0Entries,
      builtAt: now,
    },
    tier1: {
      version: 1,
      entries: tier1Entries,
      dimensions,
      model: MODEL_NAME,
      builtAt: now,
      binarySize: Math.ceil(dimensions / 8),
    },
  };
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Serialize Tier 0 index to compact JSON.
 */
export function serializeTier0Index(index: Tier0Index): string {
  const compact: CompactTier0Index = {
    v: 0,
    b: index.builtAt,
    e: index.entries.map((entry) => ({
      i: entry.id,
      s: entry.slug,
      c: entry.collection,
      t: entry.title,
      n: entry.snippet,
      k: entry.keywords,
    })),
  };
  return JSON.stringify(compact);
}

/**
 * Serialize Tier 1 index to compact JSON.
 */
export function serializeTier1Index(index: Tier1Index): string {
  const compact: CompactTier1Index = {
    v: 1,
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
      be: encodeBase64(entry.binaryEmbedding),
    })),
  };
  return JSON.stringify(compact);
}

// ============================================================================
// Size Estimation
// ============================================================================

/**
 * Estimate sizes for progressive index tiers.
 */
export function estimateProgressiveSizes(entryCount: number): {
  tier0SizeKB: number;
  tier1SizeKB: number;
  fullIndexSizeKB: number;
  tier0Savings: string;
  tier1Savings: string;
} {
  // Rough estimates based on typical content
  const avgMetadataBytes = 300; // id, slug, collection, title, snippet
  const avgKeywordsBytes = 200; // ~20 keywords * 10 chars
  const binaryEmbeddingBytes = 48; // 384 bits = 48 bytes
  const fullEmbeddingBytes = 1536; // 384 floats * 4 bytes

  const tier0Bytes = entryCount * (avgMetadataBytes + avgKeywordsBytes);
  const tier1Bytes = entryCount * (avgMetadataBytes + binaryEmbeddingBytes);
  const fullBytes = entryCount * (avgMetadataBytes + fullEmbeddingBytes);

  return {
    tier0SizeKB: Math.round(tier0Bytes / 1024),
    tier1SizeKB: Math.round(tier1Bytes / 1024),
    fullIndexSizeKB: Math.round(fullBytes / 1024),
    tier0Savings: `${Math.round((1 - tier0Bytes / fullBytes) * 100)}%`,
    tier1Savings: `${Math.round((1 - tier1Bytes / fullBytes) * 100)}%`,
  };
}
