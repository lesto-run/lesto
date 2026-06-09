/**
 * Shared constants for the embeddings package.
 */

/** Model identifier used for embeddings */
export const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

/** Embedding vector dimensions for all-MiniLM-L6-v2 */
export const EMBEDDING_DIMENSIONS = 384;

/** Binary signature size in bytes (384 bits = 48 bytes) */
export const BINARY_SIGNATURE_SIZE = 48;

/**
 * Default maximum text length for embedding generation.
 *
 * NOTE: all-MiniLM-L6-v2 has a 256-token limit (~500-1000 characters).
 * Text beyond the model's context window is silently truncated by the
 * transformer. This default of 8192 characters is retained for backwards
 * compatibility, but users should be aware that only the first ~500-1000
 * characters are actually processed by the model.
 *
 * For optimal results, consider pre-chunking long documents into smaller
 * segments (~500 chars) and embedding them separately.
 */
export const DEFAULT_MAX_TEXT_LENGTH = 8192;

/** Default snippet length for search results */
export const DEFAULT_SNIPPET_LENGTH = 200;

/** Default maximum keywords to extract */
export const DEFAULT_MAX_KEYWORDS = 50;
