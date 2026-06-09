/**
 * @keel/content-search - Browser-safe search client
 *
 * This entry point provides a Pagefind-style API for searching pre-built
 * indexes. It does NOT include embedding generation (which requires
 * @huggingface/transformers) - use @keel/content-embeddings for that.
 */

import type { SearchIndex, SearchResult, SearchClientOptions, SearchClient } from "./types";
import { searchByEmbedding, findSimilar as findSimilarImpl } from "./similarity";
import { loadSearchIndex } from "./index-format";

/**
 * Create a search client from a pre-built index.
 *
 * @param indexUrl - URL to the search index JSON file
 * @returns Search client instance
 */
export async function createSearch(indexUrl: string): Promise<SearchClient> {
  const index = await loadSearchIndex(indexUrl);
  return createSearchFromIndex(index);
}

/**
 * Create a search client from an already-loaded index.
 *
 * @param index - Search index
 * @returns Search client instance
 */
export function createSearchFromIndex(index: SearchIndex): SearchClient {
  return {
    index,

    query(queryEmbedding: number[], options: SearchClientOptions = {}): SearchResult[] {
      return searchByEmbedding(queryEmbedding, index, {
        ...(options.collections && { collections: options.collections }),
        limit: options.limit ?? 10,
        threshold: options.threshold ?? 0.3,
      });
    },

    findSimilar(entryId: string, k = 5): SearchResult[] {
      return findSimilarImpl(entryId, index.entries, k);
    },

    getEntries(): SearchResult[] {
      return index.entries.map((entry) => ({
        id: entry.id,
        slug: entry.slug,
        collection: entry.collection,
        title: entry.title,
        snippet: entry.snippet,
        score: 1,
      }));
    },

    getByCollection(collection: string): SearchResult[] {
      return index.entries
        .filter((entry) => entry.collection === collection)
        .map((entry) => ({
          id: entry.id,
          slug: entry.slug,
          collection: entry.collection,
          title: entry.title,
          snippet: entry.snippet,
          score: 1,
        }));
    },
  };
}
