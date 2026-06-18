/**
 * Text primitives shared across the search/embeddings stack.
 *
 * Keyword extraction must be byte-identical between the build-time index
 * generator (@volo/content-embeddings) and the runtime keyword search
 * (@volo/content-search): the keywords stored in a Tier 0 index are matched
 * against keywords extracted from the live query, so any drift in stop words
 * or tokenization would silently degrade recall. Keeping a single definition
 * here removes that risk.
 */

/** Default maximum number of keywords to extract from a single text. */
const DEFAULT_MAX_KEYWORDS = 50;

/**
 * Common English stop words filtered out of extracted keywords.
 *
 * Deliberately small and hand-curated (not a full linguistic stop list): these
 * are high-frequency tokens that carry no retrieval signal, so dropping them
 * keeps indexes lean without hurting recall on real queries.
 */
export const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
  "this",
  "but",
  "they",
  "have",
  "had",
  "what",
  "when",
  "where",
  "who",
  "which",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "can",
  "just",
  "should",
  "now",
  "you",
  "your",
]);

/**
 * Extract searchable keywords from text.
 *
 * Lowercases, strips punctuation to whitespace, then keeps unique tokens that
 * are at least three characters long and not stop words. Order is preserved
 * (first occurrence wins) and the result is capped at `maxKeywords`.
 */
export function extractKeywords(text: string, maxKeywords = DEFAULT_MAX_KEYWORDS): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));

  // Deduplicate (preserving first-seen order) and cap the count.
  return [...new Set(words)].slice(0, maxKeywords);
}
