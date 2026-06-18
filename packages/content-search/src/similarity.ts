/**
 * Vector similarity search using cosine similarity.
 *
 * Searches against pre-built embeddings without requiring the model at runtime.
 * Embeddings are generated at build time using @lesto/content-embeddings.
 */

import type { EmbeddingResult, SearchResult, SearchOptions, SearchIndex } from "./types";

// ============================================================================
// Similarity Functions
// ============================================================================

/**
 * Compute cosine similarity between two normalized vectors.
 * Assumes vectors are already normalized (unit length).
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @returns Cosine similarity (-1 to 1, typically 0 to 1 for similar texts)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  // For normalized vectors, cosine similarity is just the dot product
  return a.reduce((sum, val, i) => sum + val * b[i]!, 0);
}

/**
 * Compute dot product between two vectors.
 * Same as cosine similarity for normalized vectors.
 */
export function dotProduct(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  return a.reduce((sum, val, i) => sum + val * b[i]!, 0);
}

/**
 * Normalize a vector to unit length.
 * Required for proper cosine similarity computation.
 */
export function normalizeVector(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return vec;
  return vec.map((val) => val / norm);
}

// ============================================================================
// Search Functions
// ============================================================================

/**
 * Search for similar entries using vector similarity.
 *
 * @param queryEmbedding - Embedding vector for the search query
 * @param index - Pre-built search index with entry embeddings
 * @param options - Search options
 * @returns Ranked search results
 */
export function searchByEmbedding(
  queryEmbedding: number[],
  index: SearchIndex,
  options: SearchOptions = {},
): SearchResult[] {
  const { collections, limit = 10, threshold = 0.3 } = options;

  // Filter entries by collection if specified
  const candidates = collections
    ? index.entries.filter((e) => collections.includes(e.collection))
    : index.entries;

  // Score all candidates (O(n) where n = number of entries)
  // This is fast for typical documentation sizes (< 10k documents)
  const scored = candidates.map((entry) => ({
    entry,
    score: cosineSimilarity(queryEmbedding, entry.embedding),
  }));

  // Filter by threshold, sort by score descending, take top N
  return scored
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

/**
 * Search entries using a query embedding.
 * Convenience wrapper that normalizes the query embedding.
 */
export function search(
  queryEmbedding: number[],
  entries: EmbeddingResult[],
  options: SearchOptions = {},
): SearchResult[] {
  // Handle empty entries array
  if (entries.length === 0) {
    return [];
  }

  const firstEntry = entries[0];
  const index: SearchIndex = {
    entries,
    dimensions: firstEntry?.embedding.length ?? 384,
    model: "Xenova/all-MiniLM-L6-v2",
    builtAt: new Date().toISOString(),
  };

  // Normalize query embedding to ensure proper similarity calculation
  const normalizedQuery = normalizeVector(queryEmbedding);

  return searchByEmbedding(normalizedQuery, index, options);
}

/**
 * Find the k most similar entries to a given entry.
 * Useful for "related content" features.
 *
 * @param entryId - ID of the entry to find similar entries for
 * @param entries - All entry embeddings
 * @param k - Number of similar entries to return
 * @returns Similar entries (excluding the input entry)
 */
export function findSimilar(entryId: string, entries: EmbeddingResult[], k = 5): SearchResult[] {
  const sourceEntry = entries.find((e) => e.id === entryId);
  if (!sourceEntry) return [];

  const results = search(sourceEntry.embedding, entries, {
    limit: k + 1, // +1 because we'll exclude the source entry
    threshold: 0,
  });

  // Exclude the source entry itself
  return results.filter((r) => r.id !== entryId).slice(0, k);
}

/**
 * Compute similarity matrix between all entries.
 * Useful for clustering or visualization.
 * Note: O(n^2) complexity - use with caution for large datasets.
 *
 * @param entries - Entry embeddings
 * @returns nxn similarity matrix (empty array if no entries)
 */
export function computeSimilarityMatrix(entries: EmbeddingResult[]): number[][] {
  const n = entries.length;

  // Handle empty input
  if (n === 0) {
    return [];
  }

  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0) as number[]);

  for (let i = 0; i < n; i++) {
    const entryI = entries[i];
    if (!entryI) continue;

    for (let j = i; j < n; j++) {
      const entryJ = entries[j];
      if (!entryJ) continue;

      const sim = cosineSimilarity(entryI.embedding, entryJ.embedding);
      matrix[i]![j] = sim;
      matrix[j]![i] = sim; // Symmetric
    }
  }

  return matrix;
}
