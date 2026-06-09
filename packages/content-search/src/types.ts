/**
 * Type definitions for @keel/content-search (runtime, browser-safe)
 */

// ============================================================================
// Search Result Types
// ============================================================================

export interface SearchResult {
  /** Entry ID */
  id: string;
  /** Entry slug for URL routing */
  slug: string;
  /** Collection name */
  collection: string;
  /** Entry title */
  title: string;
  /** Content snippet for display */
  snippet: string;
  /** Similarity score (0-1, higher is more similar) */
  score: number;
}

export interface SearchOptions {
  /** Filter by collection names */
  collections?: string[];
  /** Maximum number of results. Default: 10 */
  limit?: number;
  /** Minimum similarity threshold (0-1). Default: 0.3 */
  threshold?: number;
}

// ============================================================================
// Embedding Types (for runtime search)
// ============================================================================

export interface EmbeddingResult {
  /** Entry ID */
  id: string;
  /** Slug for URL routing */
  slug: string;
  /** Collection name */
  collection: string;
  /** Title for display */
  title: string;
  /** Text snippet for search results (first ~200 chars of content) */
  snippet: string;
  /** 384-dimensional embedding vector */
  embedding: number[];
}

// ============================================================================
// Search Index Types
// ============================================================================

export interface SearchIndex {
  /** Embedding results from generateEmbeddings() */
  entries: EmbeddingResult[];
  /** Embedding dimensions (should be 384 for all-MiniLM-L6-v2) */
  dimensions: number;
  /** Model used to generate embeddings */
  model: string;
  /** Build timestamp */
  builtAt: string;
}

// ============================================================================
// Binary Search Types (Runtime)
// ============================================================================

/**
 * Binary embedding result with quantized signature.
 */
export interface BinaryEmbeddingResult extends EmbeddingResult {
  /** Binary signature (48 bytes for 384-dim embeddings) */
  binaryEmbedding: Uint8Array;
}

/**
 * Binary search index with quantized embeddings.
 */
export interface BinarySearchIndex {
  /** Entries with binary embeddings */
  entries: BinaryEmbeddingResult[];
  /** Embedding dimensions (384 for all-MiniLM-L6-v2) */
  dimensions: number;
  /** Model used to generate embeddings */
  model: string;
  /** Build timestamp */
  builtAt: string;
  /** Binary signature size in bytes */
  binarySize: number;
}

// ============================================================================
// Progressive Loading Types
// ============================================================================

export interface Tier0Entry {
  /** Entry ID */
  id: string;
  /** URL-friendly identifier */
  slug: string;
  /** Collection name */
  collection: string;
  /** Entry title */
  title: string;
  /** Content snippet for display */
  snippet: string;
  /** Keywords extracted from content (for keyword search) */
  keywords: string[];
}

export interface Tier0Index {
  /** Index version */
  version: 0;
  /** Entries with metadata only (no embeddings) */
  entries: Tier0Entry[];
  /** Build timestamp */
  builtAt: string;
}

export interface Tier1Entry {
  /** Entry ID */
  id: string;
  /** URL-friendly identifier */
  slug: string;
  /** Collection name */
  collection: string;
  /** Entry title */
  title: string;
  /** Content snippet for display */
  snippet: string;
  /** Binary quantized embedding (48 bytes for 384-dim) */
  binaryEmbedding: Uint8Array;
}

export interface Tier1Index {
  /** Index version */
  version: 1;
  /** Entries with binary embeddings */
  entries: Tier1Entry[];
  /** Embedding dimensions (384 for all-MiniLM-L6-v2) */
  dimensions: number;
  /** Model used to generate embeddings */
  model: string;
  /** Build timestamp */
  builtAt: string;
  /** Binary signature size in bytes */
  binarySize: number;
}

export interface CompactTier0Index {
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

export interface CompactTier1Index {
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

// ============================================================================
// Client Types
// ============================================================================

export interface SearchClientOptions {
  /** Filter by collection names */
  collections?: string[];
  /** Maximum number of results. Default: 10 */
  limit?: number;
  /** Minimum similarity threshold (0-1). Default: 0.3 */
  threshold?: number;
}

export interface SearchClient {
  /** The loaded search index */
  index: SearchIndex;

  /**
   * Search for entries matching a query embedding.
   */
  query(queryEmbedding: number[], options?: SearchClientOptions): SearchResult[];

  /**
   * Find entries similar to a given entry.
   */
  findSimilar(entryId: string, k?: number): SearchResult[];

  /**
   * Get all entries in the index.
   */
  getEntries(): SearchResult[];

  /**
   * Get entries filtered by collection.
   */
  getByCollection(collection: string): SearchResult[];
}

// ============================================================================
// Query Intelligence Types
// ============================================================================

export interface ProcessedQuery {
  /** Original user input */
  original: string;
  /** Typo-corrected query */
  corrected: string;
  /** All search terms (original + stemmed + expanded) */
  terms: string[];
  /** Exact phrases to match (from quoted strings) */
  mustMatch: string[];
  /** Whether typo correction was applied */
  wasTypoCorrected: boolean;
}

export interface QueryIntelligenceOptions {
  /** Maximum Levenshtein distance for typo correction. Default: 2 */
  maxTypoDistance?: number;
  /** Whether to apply stemming. Default: true */
  enableStemming?: boolean;
  /** Whether to expand synonyms. Default: true */
  enableSynonyms?: boolean;
  /** Custom synonym definitions */
  customSynonyms?: Record<string, string[]>;
}

// ============================================================================
// RAG Types
// ============================================================================

export interface RAGSearchRequest {
  /** Search query string */
  query: string;
  /** Filter by collection names */
  collections?: string[];
  /** Maximum results to return. Default: 10 */
  limit?: number;
  /** Conversation/session context */
  context?: {
    /** Previous queries in this session */
    previousQueries?: string[];
    /** Current page URL or path */
    currentPage?: string;
    /** User session ID for caching */
    sessionId?: string;
  };
}

export interface RAGSearchResponse {
  /** Search results with scores */
  results: SearchResult[];
  /** Synthesized answer for question queries */
  answer?: string;
  /** Suggested query refinements */
  relatedQueries?: string[];
  /** Server-side latency in ms */
  latency: number;
  /** Whether results came from cache */
  cached: boolean;
}
