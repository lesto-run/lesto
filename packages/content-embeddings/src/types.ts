/**
 * Type definitions for @volo/content-embeddings (build-time only)
 */

// ============================================================================
// Entry Types
// ============================================================================

/**
 * Minimal entry interface for embedding operations.
 * Compatible with @volo/content-core RuntimeEntry.
 */
export interface SearchableEntry {
  /** Unique entry ID */
  id: string;
  /** URL-friendly identifier */
  slug: string;
  /** Collection name */
  collection: string;
  /** Entry title (optional) */
  title?: string;
  /** Entry content (optional) */
  content?: string;
  /** Any additional fields */
  [key: string]: unknown;
}

// ============================================================================
// Embedding Types
// ============================================================================

export interface EmbeddingResult {
  /** Entry ID from id field */
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

export interface EmbeddingProgress {
  current: number;
  total: number;
  entry: string;
}

export interface GenerateEmbeddingsOptions {
  /** Progress callback */
  onProgress?: (progress: EmbeddingProgress) => void;
  /** Maximum text length to embed (truncates content). Default: 8192 */
  maxTextLength?: number;
  /** Snippet length for search results. Default: 200 */
  snippetLength?: number;
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

export interface GenerateSearchIndexOptions {
  /** Model identifier. Default: "Xenova/all-MiniLM-L6-v2" */
  model?: string;
  /** Use compact format to reduce file size. Default: true */
  compact?: boolean;
}

// ============================================================================
// Cache Types
// ============================================================================

export interface EmbeddingCacheEntry {
  /** Content hash */
  hash: string;
  /** Entry metadata */
  id: string;
  slug: string;
  collection: string;
  title: string;
  snippet: string;
  /** Cached embedding */
  embedding: number[];
  /** Cache timestamp */
  cachedAt: string;
}

export interface EmbeddingCache {
  /** Cache version for format changes */
  version: 1;
  /** Model used for embeddings */
  model: string;
  /** Cache entries keyed by entry ID */
  entries: Record<string, EmbeddingCacheEntry>;
}

export interface CachedEmbeddingsOptions extends GenerateEmbeddingsOptions {
  /** Cache directory. Default: .docks/cache */
  cacheDir?: string;
  /** Force regeneration (ignore cache). Default: false */
  force?: boolean;
}

export interface EmbeddingCacheStats {
  /** Number of entries loaded from cache */
  hits: number;
  /** Number of entries generated fresh */
  misses: number;
  /** Total entries processed */
  total: number;
  /** Cache hit rate (0-1) */
  hitRate: number;
}

// ============================================================================
// Binary Quantization Types
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
// Progressive Loading Index Types (2-Tier Architecture)
// ============================================================================

/**
 * Tier 0: Metadata-only index for instant keyword search.
 * Preloaded via `<link rel="preload">` for immediate availability.
 */
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

/**
 * Tier 1: Binary-only index for fast semantic search.
 * Loaded in background after Tier 0 is ready.
 */
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

/**
 * Compact Tier 0 format for JSON serialization.
 */
export interface CompactTier0Index {
  /** version = 0 */
  v: 0;
  /** built at timestamp */
  b: string;
  /** entries */
  e: Array<{
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
    /** keywords */
    k: string[];
  }>;
}

/**
 * Compact Tier 1 format for JSON serialization.
 */
export interface CompactTier1Index {
  /** version = 1 for Tier 1 binary-only */
  v: 1;
  /** model */
  m: string;
  /** dimensions */
  d: number;
  /** built at timestamp */
  b: string;
  /** binary size in bytes */
  bs: number;
  /** entries */
  e: Array<{
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
    /** binary embedding (base64-encoded) */
    be: string;
  }>;
}

// ============================================================================
// Zero-Copy Index Types
// ============================================================================

/**
 * Input entry for building zero-copy index.
 */
export interface ZeroCopyInputEntry {
  id: string;
  title: string;
  slug: string;
  snippet: string;
  collection: string;
  /** Binary signature (from binaryQuantize) */
  binarySignature: Uint8Array;
}
