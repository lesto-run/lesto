/**
 * @lesto/content-embeddings
 *
 * Build-time embedding generation for semantic search.
 * This package is used at build time to generate search indexes.
 * For runtime search functionality, use @lesto/content-search.
 */

// Embedding generation
export {
  generateEmbedding,
  generateEmbeddings,
  disposeEmbedder,
  stripMarkdown,
} from "./embeddings";

// Caching
export { generateEmbeddingsWithCache, clearEmbeddingCache, getEmbeddingCacheStats } from "./cache";

// Index serialization
export { serializeSearchIndex, estimateIndexSize } from "./index-format";

// Binary quantization (build-time)
export {
  binaryQuantize,
  binaryDequantize,
  addBinaryEmbeddings,
  createBinaryIndex,
  serializeBinaryIndex,
  serializeBinaryOnlyIndex,
  estimateBinarySavings,
} from "./binary";

// Progressive indexes (build-time)
export {
  extractKeywords,
  generateProgressiveIndex,
  serializeTier0Index,
  serializeTier1Index,
  estimateProgressiveSizes,
} from "./progressive";

// Zero-copy format (build-time)
export {
  createZeroCopyIndex,
  toZeroCopyInput,
  toZeroCopyInputFromEmbedding,
  estimateZeroCopySize,
  validateZeroCopyIndex,
  IndexFlags,
} from "./zero-copy";

// Constants
export {
  MODEL_NAME,
  EMBEDDING_DIMENSIONS,
  BINARY_SIGNATURE_SIZE,
  DEFAULT_MAX_TEXT_LENGTH,
  DEFAULT_SNIPPET_LENGTH,
  DEFAULT_MAX_KEYWORDS,
} from "./constants";

// Types
export type {
  // Entry types
  SearchableEntry,
  // Embedding types
  EmbeddingResult,
  EmbeddingProgress,
  GenerateEmbeddingsOptions,
  // Index types
  SearchIndex,
  GenerateSearchIndexOptions,
  // Cache types
  EmbeddingCache,
  EmbeddingCacheEntry,
  CachedEmbeddingsOptions,
  EmbeddingCacheStats,
  // Binary types
  BinaryEmbeddingResult,
  BinarySearchIndex,
  // Progressive types
  Tier0Entry,
  Tier0Index,
  Tier1Entry,
  Tier1Index,
  CompactTier0Index,
  CompactTier1Index,
  // Zero-copy types
  ZeroCopyInputEntry,
} from "./types";

// NOTE: Search quality benchmarking has moved to @lesto/content-search
// import { runBenchmark, checkQualityGates } from "@lesto/content-search"
