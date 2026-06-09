/// <reference lib="dom" />

/**
 * @keel/content-search/react - React hook for client-side search
 *
 * Zero-config search hook with sensible defaults.
 * Combines semantic search with keyword matching for best results.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { createCache, CACHE_LIMITS, CACHE_TTL } from '@keel/content-shared/cache';
import { binaryQuantize, hammingDistance, hammingToSimilarity } from './binary';
import { createQueryProcessor, type QueryProcessor } from './query-intelligence';
import { shouldFallbackToRAG, RAGClient, mergeResults } from './rag-fallback';
import type { ProcessedQuery } from './types';
import type { SearchResult } from './types';

// ============================================================================
// Types
// ============================================================================

export interface UseSearchOptions {
  indexPath?: string;
  limit?: number;
  collections?: string[];
  threshold?: number;
  debounce?: number;
  typoTolerance?: boolean;
  stemming?: boolean;
  synonyms?: Record<string, string[]>;
  onSearch?: (results: SearchResult[]) => void;
  embedApi?: string | false;
  semanticWeight?: number;
  progressive?: boolean;
  progressivePath?: string;
  ragFallback?: boolean;
  ragEndpoint?: string;
  ragMinConfidence?: number;
}

export interface UseSearchReturn {
  query: string;
  setQuery: (query: string) => void;
  results: SearchResult[];
  isSearching: boolean;
  isReady: boolean;
  semanticEnabled: boolean;
  error: Error | null;
  search: (query: string) => void;
  clear: () => void;
  tier: 0 | 1 | 'full';
  hasBinarySearch: boolean;
  hasRagResults: boolean;
  resultSource: 'local' | 'rag' | 'hybrid';
  ragAnswer: string | undefined;
}

// ============================================================================
// Index Types
// ============================================================================

interface CompactEntry {
  i: string;
  s: string;
  c: string;
  t: string;
  n: string;
  e: string;
  b?: string;
}

interface IndexV1 {
  v: 1;
  d: number;
  m: string;
  b: string;
  e: CompactEntry[];
}

interface CompactTier0 {
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

interface CompactTier1 {
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

interface LoadedEntry {
  id: string;
  slug: string;
  collection: string;
  title: string;
  snippet: string;
  keywords?: string[];
  embedding?: number[];
  binaryEmbedding?: Uint8Array;
}

interface LoadedIndex {
  entries: LoadedEntry[];
  dimensions: number;
  model: string;
  hasBinaryEmbeddings: boolean;
  hasKeywords: boolean;
  tier: 0 | 1 | 'full';
}

// ============================================================================
// Index Loading
// ============================================================================

// Use shared LRU cache for search indexes (memory-heavy, limited to 10)
const indexCache = createCache<Promise<LoadedIndex>>({
  max: CACHE_LIMITS.SEARCH_INDEX,
  ttl: CACHE_TTL.LONG,
});

function decodeFloat32(encoded: string): number[] {
  const binaryString = atob(encoded);
  const bytes = Uint8Array.from(binaryString, (c) => c.charCodeAt(0));
  const alignedBuffer = new ArrayBuffer(bytes.length);
  new Uint8Array(alignedBuffer).set(bytes);
  return Array.from(new Float32Array(alignedBuffer));
}

function decodeUint8(encoded: string): Uint8Array {
  const binaryString = atob(encoded);
  return Uint8Array.from(binaryString, (c) => c.charCodeAt(0));
}

async function loadTier0Index(tier0Path: string): Promise<LoadedIndex> {
  const response = await fetch(tier0Path);
  if (!response.ok) {
    throw new Error(`Failed to load Tier 0 index: ${response.status}`);
  }

  const data = await response.json() as CompactTier0;

  if (data.v !== 0) {
    throw new Error(`Unsupported Tier 0 index version: ${data.v}`);
  }

  const entries: LoadedEntry[] = data.e.map((e) => ({
    id: e.i,
    slug: e.s,
    collection: e.c,
    title: e.t,
    snippet: e.n,
    keywords: e.k,
  }));

  return {
    entries,
    dimensions: 384,
    model: 'unknown',
    hasBinaryEmbeddings: false,
    hasKeywords: true,
    tier: 0,
  };
}

async function loadTier1Index(tier1Path: string, existingEntries: LoadedEntry[]): Promise<LoadedIndex> {
  const response = await fetch(tier1Path);
  if (!response.ok) {
    throw new Error(`Failed to load Tier 1 index: ${response.status}`);
  }

  const data = await response.json() as CompactTier1;

  if (data.v !== 1) {
    throw new Error(`Unsupported Tier 1 index version: ${data.v}`);
  }

  const entryMap = new Map(existingEntries.map((e) => [e.id, e]));

  for (const e of data.e) {
    const existing = entryMap.get(e.i);
    if (existing) {
      existing.binaryEmbedding = decodeUint8(e.be);
    } else {
      entryMap.set(e.i, {
        id: e.i,
        slug: e.s,
        collection: e.c,
        title: e.t,
        snippet: e.n,
        binaryEmbedding: decodeUint8(e.be),
      });
    }
  }

  return {
    entries: Array.from(entryMap.values()),
    dimensions: data.d,
    model: data.m,
    hasBinaryEmbeddings: true,
    hasKeywords: existingEntries.some((e) => e.keywords),
    tier: 1,
  };
}

async function loadIndex(indexPath: string): Promise<LoadedIndex> {
  const cached = indexCache.get(indexPath);
  if (cached) return cached;

  const promise = (async () => {
    const response = await fetch(indexPath);
    if (!response.ok) {
      indexCache.delete(indexPath);
      throw new Error(`Failed to load search index: ${response.status}`);
    }

    const json: unknown = await response.json();

    if (json && typeof json === 'object' && 'v' in json && (json as Record<string, unknown>)['v'] === 1) {
      const data = json as IndexV1;
      const hasBinary = data.e.some((e) => e.b);

      const entries: LoadedEntry[] = data.e.map((e) => {
        const entry: LoadedEntry = {
          id: e.i,
          slug: e.s,
          collection: e.c,
          title: e.t,
          snippet: e.n,
        };

        if (e.b) {
          entry.binaryEmbedding = decodeUint8(e.b);
        } else if (e.e) {
          entry.embedding = decodeFloat32(e.e);
          entry.binaryEmbedding = binaryQuantize(entry.embedding);
        }

        return entry;
      });

      return {
        entries,
        dimensions: data.d,
        model: data.m,
        hasBinaryEmbeddings: hasBinary || entries.some((e) => e.binaryEmbedding),
        hasKeywords: false,
        tier: 'full' as const,
      };
    }

    const rawData = json as Record<string, unknown>;
    return {
      entries: (rawData['entries'] as LoadedEntry[]) || [],
      dimensions: (rawData['dimensions'] as number) || 384,
      model: (rawData['model'] as string) || 'unknown',
      hasBinaryEmbeddings: false,
      hasKeywords: false,
      tier: 'full' as const,
    };
  })();

  // LRU cache handles eviction automatically
  indexCache.set(indexPath, promise);
  return promise;
}

// ============================================================================
// Search Logic
// ============================================================================

function keywordScore(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lowerText = text.toLowerCase();
  const matches = terms.filter((term) => lowerText.includes(term.toLowerCase()));
  return matches.length / terms.length;
}

function keywordScoreWithIndex(entry: LoadedEntry, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;

  const querySet = new Set(queryTerms.map((t) => t.toLowerCase()));

  if (entry.keywords && entry.keywords.length > 0) {
    const matches = entry.keywords.filter((k) => querySet.has(k.toLowerCase())).length;
    const kwScore = matches / queryTerms.length;
    const titleLower = entry.title.toLowerCase();
    const titleMatch = queryTerms.some((t) => titleLower.includes(t.toLowerCase())) ? 0.3 : 0;
    return Math.min(kwScore * 0.7 + titleMatch, 1);
  }

  const titleScore = keywordScore(entry.title, queryTerms) * 2;
  const snippetScore = keywordScore(entry.snippet, queryTerms);
  return Math.min((titleScore + snippetScore) / 3, 1);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  return a.reduce((sum, val, i) => sum + val * (b[i] ?? 0), 0);
}

function keywordOnlySearch(
  entries: LoadedEntry[],
  processedQuery: ProcessedQuery,
  options: { limit: number; threshold: number; collections?: string[] }
): SearchResult[] {
  const candidates = options.collections
    ? entries.filter((e) => options.collections!.includes(e.collection))
    : entries;

  const terms = processedQuery.terms ?? [];

  const scored = candidates.map((entry) => {
    const score = keywordScoreWithIndex(entry, terms);
    return { entry, score };
  });

  return scored
    .filter(({ score }) => score >= options.threshold)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, options.limit)
    .map(({ entry, score }) => ({
      id: entry.id,
      slug: entry.slug,
      collection: entry.collection,
      title: entry.title,
      snippet: entry.snippet,
      score,
    }));
}

// ============================================================================
// React Hook
// ============================================================================

const DEFAULT_OPTIONS: Required<Omit<UseSearchOptions, 'onSearch' | 'collections' | 'synonyms'>> = {
  indexPath: '/search-index.json',
  limit: 10,
  threshold: 0.1,
  debounce: 150,
  typoTolerance: true,
  stemming: true,
  embedApi: '/api/embed',
  semanticWeight: 0.7,
  progressive: false,
  progressivePath: '',
  ragFallback: false,
  ragEndpoint: '/api/search',
  ragMinConfidence: 0.4,
};

// Use shared LRU cache for embedding vectors (each ~1.5KB, limited to 100)
const embeddingCache = createCache<number[]>({
  max: CACHE_LIMITS.EMBEDDINGS,
  ttl: CACHE_TTL.MEDIUM,
});

async function getQueryEmbedding(query: string, embedApi: string): Promise<number[] | null> {
  const normalizedQuery = query.trim().toLowerCase();

  const cached = embeddingCache.get(normalizedQuery);
  if (cached) return cached;

  try {
    const response = await fetch(embedApi, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: normalizedQuery }),
    });

    if (!response.ok) return null;

    const data = await response.json() as { embedding?: number[] };
    const embedding = data.embedding;
    if (!embedding || !Array.isArray(embedding)) return null;

    // LRU cache handles eviction automatically
    embeddingCache.set(normalizedQuery, embedding);

    return embedding;
  } catch {
    return null;
  }
}

function calculateSemanticScore(entry: LoadedEntry, queryEmbedding: number[]): number {
  if (entry.embedding) {
    return cosineSimilarity(queryEmbedding, entry.embedding);
  }
  if (entry.binaryEmbedding) {
    const queryBinary = binaryQuantize(queryEmbedding);
    const distance = hammingDistance(queryBinary, entry.binaryEmbedding);
    return hammingToSimilarity(distance, queryBinary.length * 8);
  }
  return 0;
}

function hybridSearchEntries(
  entries: LoadedEntry[],
  processedQuery: ProcessedQuery,
  queryEmbedding: number[],
  options: { limit: number; threshold: number; collections?: string[]; semanticWeight: number }
): SearchResult[] {
  const candidates = options.collections
    ? entries.filter((e) => options.collections!.includes(e.collection))
    : entries;

  const keywordWeight = 1 - options.semanticWeight;
  const terms = processedQuery.terms ?? [];

  const scored = candidates.map((entry) => {
    const semanticScore = calculateSemanticScore(entry, queryEmbedding);
    const titleScore = keywordScore(entry.title, terms) * 2;
    const snippetScore = keywordScore(entry.snippet, terms);
    const kwScore = Math.min((titleScore + snippetScore) / 3, 1);
    const score = semanticScore * options.semanticWeight + kwScore * keywordWeight;

    return { entry, score };
  });

  return scored
    .filter(({ score }) => score >= options.threshold)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, options.limit)
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
 * React hook for client-side search with zero configuration.
 */
export function useSearch(options: UseSearchOptions = {}): UseSearchReturn {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const {
    indexPath,
    limit,
    threshold,
    debounce,
    typoTolerance,
    stemming,
    synonyms,
    collections,
    onSearch,
    embedApi,
    semanticWeight,
    progressive,
    progressivePath,
    ragFallback,
    ragEndpoint,
    ragMinConfidence,
  } = opts;

  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [semanticEnabled, setSemanticEnabled] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tier, setTier] = useState<0 | 1 | 'full'>('full');
  const [hasBinarySearch, setHasBinarySearch] = useState(false);
  const [hasRagResults, setHasRagResults] = useState(false);
  const [resultSource, setResultSource] = useState<'local' | 'rag' | 'hybrid'>('local');
  const [ragAnswer, setRagAnswer] = useState<string | undefined>(undefined);

  const indexRef = useRef<LoadedIndex | null>(null);
  const searchIdRef = useRef(0);
  const queryProcessorRef = useRef<QueryProcessor | null>(null);
  const ragClientRef = useRef<RAGClient | null>(null);

  useEffect(() => {
    if (ragFallback && ragEndpoint) {
      ragClientRef.current = new RAGClient({ endpoint: ragEndpoint });
    }
  }, [ragFallback, ragEndpoint]);

  useEffect(() => {
    queryProcessorRef.current = createQueryProcessor({
      maxTypoDistance: typoTolerance ? 2 : 0,
      enableStemming: stemming,
      ...(synonyms && { customSynonyms: synonyms }),
    });
  }, [typoTolerance, stemming, synonyms]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (progressive) {
      const basePath = progressivePath ? `${progressivePath}/` : '/';
      const tier0Path = `${basePath}search-tier0.json`;
      const tier1Path = `${basePath}search-tier1.json`;

      loadTier0Index(tier0Path)
        .then((tier0Index) => {
          indexRef.current = tier0Index;
          setTier(0);
          setIsReady(true);

          return loadTier1Index(tier1Path, tier0Index.entries)
            .then((tier1Index) => {
              indexRef.current = tier1Index;
              setTier(1);
              setHasBinarySearch(true);
              return tier1Index;
            })
            .catch((err) => {
              console.warn('Failed to load Tier 1 index:', err);
              return undefined;
            });
        })
        .catch((err) => {
          console.warn('Tier 0 load failed, falling back to full index:', err);
          return loadIndex(indexPath)
            .then((index) => {
              indexRef.current = index;
              setTier('full');
              setHasBinarySearch(index.hasBinaryEmbeddings);
              setIsReady(true);
              return index;
            })
            .catch((fallbackErr) => {
              setError(fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)));
              return undefined;
            });
        });
    } else {
      loadIndex(indexPath)
        .then((index) => {
          indexRef.current = index;
          setTier('full');
          setHasBinarySearch(index.hasBinaryEmbeddings);
          setIsReady(true);
          return index;
        })
        .catch((err) => {
          setError(err instanceof Error ? err : new Error(String(err)));
        });
    }
  }, [indexPath, progressive, progressivePath]);

  const performSearch = useCallback(
    async (searchQuery: string) => {
      const trimmed = searchQuery.trim();
      const index = indexRef.current;
      const processor = queryProcessorRef.current;

      if (!index || !processor || !trimmed) {
        setResults([]);
        setIsSearching(false);
        setHasRagResults(false);
        setResultSource('local');
        setRagAnswer(undefined);
        return;
      }

      setIsSearching(true);
      setHasRagResults(false);
      setResultSource('local');
      setRagAnswer(undefined);
      const currentSearchId = ++searchIdRef.current;
      const processed = processor.process(trimmed);

      const searchOptions = {
        limit,
        threshold,
        ...(collections && { collections }),
      };

      const executeSearch = async (): Promise<{ results: SearchResult[]; semantic: boolean }> => {
        if (!embedApi) {
          return { results: keywordOnlySearch(index.entries, processed, searchOptions), semantic: false };
        }

        const queryEmbedding = await getQueryEmbedding(trimmed, embedApi);

        if (searchIdRef.current !== currentSearchId) {
          return { results: [], semantic: false };
        }

        if (queryEmbedding) {
          return {
            results: hybridSearchEntries(index.entries, processed, queryEmbedding, {
              ...searchOptions,
              semanticWeight,
            }),
            semantic: true,
          };
        }

        return { results: keywordOnlySearch(index.entries, processed, searchOptions), semantic: false };
      };

      const { results: localResults, semantic } = await executeSearch();

      if (searchIdRef.current !== currentSearchId) return;

      const ragClient = ragClientRef.current;
      const needsRag = ragFallback && ragClient && shouldFallbackToRAG(trimmed, localResults, {
        minConfidence: ragMinConfidence,
      });

      if (!needsRag) {
        setSemanticEnabled(semantic);
        setResults(localResults);
        setResultSource('local');
        setIsSearching(false);
        onSearch?.(localResults);
        return;
      }

      setSemanticEnabled(semantic);
      setResults(localResults);
      setResultSource('local');

      try {
        const ragResponse = await ragClient.search(trimmed, collections ? { collections, limit } : { limit });

        if (searchIdRef.current !== currentSearchId) return;

        if (ragResponse.results.length > 0) {
          const merged = mergeResults(localResults, ragResponse.results, { ragWeight: 0.6 });
          setResults(merged);
          setHasRagResults(true);
          setResultSource(localResults.length > 0 ? 'hybrid' : 'rag');
          setRagAnswer(ragResponse.answer);
          onSearch?.(merged);
        }
      } catch (ragError) {
        console.warn('RAG fallback failed:', ragError);
      }

      setIsSearching(false);
    },
    [limit, threshold, collections, onSearch, embedApi, semanticWeight, ragFallback, ragMinConfidence]
  );

  useEffect(() => {
    if (!isReady) return;

    const timer = setTimeout(() => {
      performSearch(query);
    }, debounce);

    return () => clearTimeout(timer);
  }, [query, isReady, debounce, performSearch]);

  const setQuery = useCallback((newQuery: string) => {
    setQueryState(newQuery);
  }, []);

  const search = useCallback(
    (searchQuery: string) => {
      setQueryState(searchQuery);
      performSearch(searchQuery);
    },
    [performSearch]
  );

  const clear = useCallback(() => {
    setQueryState('');
    setResults([]);
  }, []);

  return {
    query,
    setQuery,
    results,
    isSearching,
    isReady,
    semanticEnabled,
    error,
    search,
    clear,
    tier,
    hasBinarySearch,
    hasRagResults,
    resultSource,
    ragAnswer,
  };
}

export default useSearch;

// Re-export types for convenience
export type { SearchResult } from './types';
