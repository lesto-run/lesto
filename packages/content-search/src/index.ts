/**
 * @volo/content-search
 *
 * Client-safe vector search for semantic content discovery.
 * This package is designed for browser/runtime use.
 * For build-time embedding generation, use @volo/content-embeddings.
 */

// ============================================================================
// Similarity & Search
// ============================================================================

export {
  cosineSimilarity,
  dotProduct,
  normalizeVector,
  searchByEmbedding,
  search,
  findSimilar,
  computeSimilarityMatrix,
} from "./similarity";

// ============================================================================
// Binary Search
// ============================================================================

export {
  binaryQuantize,
  hammingDistance,
  hammingToSimilarity,
  thresholdToHamming,
  parseBinaryIndex,
  loadBinaryIndex,
  binarySearch,
  hybridSearch,
} from "./binary";

// ============================================================================
// Index Loading & Parsing
// ============================================================================

export { parseSearchIndex, loadSearchIndex } from "./index-format";

// ============================================================================
// Progressive Loading
// ============================================================================

export {
  extractKeywords,
  parseTier0Index,
  parseTier1Index,
  loadTier0Index,
  loadTier1Index,
  keywordSearch,
  binarySemanticSearch,
} from "./progressive";

// ============================================================================
// Zero-Copy Index
// ============================================================================

export { ZeroCopyIndex, loadZeroCopyIndex, IndexFlags } from "./zero-copy";

export type { ZeroCopyEntry, DecodedEntry, ZeroCopySearchResult } from "./zero-copy";

// ============================================================================
// Search Client
// ============================================================================

export { createSearch, createSearchFromIndex } from "./client";

// ============================================================================
// Query Intelligence
// ============================================================================

export {
  stem,
  levenshteinDistance,
  BKTree,
  DEFAULT_SYNONYMS,
  buildSynonymMap,
  tokenize,
  extractQuotedPhrases,
  QueryProcessor,
  createQueryProcessor,
  preprocessQuery,
} from "./query-intelligence";

// ============================================================================
// RAG Fallback
// ============================================================================

export {
  shouldFallbackToRAG,
  analyzeQueryComplexity,
  RAGClient,
  mergeResults,
  getResultSource,
} from "./rag-fallback";

export type { RAGFallbackOptions, RAGClientOptions } from "./rag-fallback";

// ============================================================================
// Types
// ============================================================================

export type {
  SearchResult,
  SearchOptions,
  EmbeddingResult,
  SearchIndex,
  BinaryEmbeddingResult,
  BinarySearchIndex,
  Tier0Entry,
  Tier0Index,
  Tier1Entry,
  Tier1Index,
  CompactTier0Index,
  CompactTier1Index,
  SearchClientOptions,
  SearchClient,
  ProcessedQuery,
  QueryIntelligenceOptions,
  RAGSearchRequest,
  RAGSearchResponse,
} from "./types";

// ============================================================================
// Benchmarking
// ============================================================================

export {
  runBenchmark,
  createBenchmarkDataset,
  checkQualityGates,
  formatBenchmarkReport,
  Relevance,
  SAMPLE_DOC_BENCHMARK,
  DEFAULT_THRESHOLDS,
  STRICT_THRESHOLDS,
} from "./benchmark";

export type {
  QueryCategory,
  BenchmarkQuery,
  BenchmarkDataset,
  QueryBenchmarkResult,
  QualityMetrics,
  PerformanceMetrics,
  BenchmarkReport,
  SearchFunction,
  QualityThresholds,
} from "./benchmark";
