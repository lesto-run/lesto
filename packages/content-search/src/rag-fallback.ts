/**
 * RAG Fallback Strategy for Complex Queries
 *
 * Provides server-side RAG fallback for queries that exceed
 * client-side search capabilities.
 */

import type { SearchResult, RAGSearchRequest, RAGSearchResponse } from "./types";

// ============================================================================
// RAG Detection Heuristics
// ============================================================================

const QUESTION_PATTERNS = [
  /^(how|what|why|when|where|who|which|can|does|is|are|do|will|should|could|would)\s+/i,
  /\?$/,
];

const COMPLEX_PATTERNS = [
  /\s+(and|or|with|without|but|vs\.?|versus)\s+/i,
  /\s+(not|except|excluding)\s+/i,
];

export interface RAGFallbackOptions {
  minConfidence?: number;
  maxQueryWords?: number;
  detectQuestions?: boolean;
  detectComplex?: boolean;
}

const DEFAULT_RAG_OPTIONS: Required<RAGFallbackOptions> = {
  minConfidence: 0.4,
  maxQueryWords: 6,
  detectQuestions: true,
  detectComplex: true,
};

/**
 * Determine if a query should fall back to server-side RAG search.
 */
export function shouldFallbackToRAG(
  query: string,
  localResults: SearchResult[],
  options: RAGFallbackOptions = {}
): boolean {
  const opts = { ...DEFAULT_RAG_OPTIONS, ...options };
  const trimmedQuery = query.trim();

  if (localResults.length === 0) {
    return true;
  }

  const topScore = localResults[0]?.score ?? 0;
  if (topScore < opts.minConfidence) {
    return true;
  }

  if (opts.detectQuestions) {
    for (const pattern of QUESTION_PATTERNS) {
      if (pattern.test(trimmedQuery)) {
        return true;
      }
    }
  }

  if (opts.detectComplex) {
    for (const pattern of COMPLEX_PATTERNS) {
      if (pattern.test(trimmedQuery)) {
        return true;
      }
    }
  }

  const wordCount = trimmedQuery.split(/\s+/).filter(Boolean).length;
  if (wordCount > opts.maxQueryWords) {
    return true;
  }

  return false;
}

/**
 * Analyze query complexity for debugging/logging.
 */
export function analyzeQueryComplexity(query: string): {
  isQuestion: boolean;
  isComplex: boolean;
  wordCount: number;
  triggers: string[];
} {
  const trimmedQuery = query.trim();
  const triggers: string[] = [];

  const isQuestion = QUESTION_PATTERNS.some((p) => p.test(trimmedQuery));
  if (isQuestion) triggers.push("question");

  const isComplex = COMPLEX_PATTERNS.some((p) => p.test(trimmedQuery));
  if (isComplex) triggers.push("complex");

  const wordCount = trimmedQuery.split(/\s+/).filter(Boolean).length;
  if (wordCount > 6) triggers.push("long");

  return { isQuestion, isComplex, wordCount, triggers };
}

// ============================================================================
// RAG Client
// ============================================================================

export interface RAGClientOptions {
  endpoint?: string;
  timeout?: number;
  cache?: boolean;
  cacheTTL?: number;
}

const DEFAULT_CLIENT_OPTIONS: Required<RAGClientOptions> = {
  endpoint: "/api/search",
  timeout: 10000,
  cache: true,
  cacheTTL: 300000,
};

/**
 * Client for server-side RAG search.
 */
export class RAGClient {
  private readonly options: Required<RAGClientOptions>;
  private readonly cache: Map<string, { response: RAGSearchResponse; expires: number }>;

  constructor(options: RAGClientOptions = {}) {
    this.options = { ...DEFAULT_CLIENT_OPTIONS, ...options };
    this.cache = new Map();
  }

  async search(
    query: string,
    request: Omit<RAGSearchRequest, "query"> = {}
  ): Promise<RAGSearchResponse> {
    const normalizedQuery = query.trim().toLowerCase();
    const cacheKey = this.getCacheKey(normalizedQuery, request);

    if (this.options.cache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expires > Date.now()) {
        return { ...cached.response, cached: true };
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.options.timeout);

    try {
      const response = await fetch(this.options.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, ...request }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`RAG search failed: ${response.status}`);
      }

      const data = (await response.json()) as RAGSearchResponse;

      if (this.options.cache) {
        this.cache.set(cacheKey, {
          response: data,
          expires: Date.now() + this.options.cacheTTL,
        });
        this.cleanupCache();
      }

      return { ...data, cached: false };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("RAG search timeout", { cause: error });
      }
      throw error;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  private getCacheKey(query: string, request: Omit<RAGSearchRequest, "query">): string {
    return JSON.stringify({ query, ...request });
  }

  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (value.expires <= now) {
        this.cache.delete(key);
      }
    }
  }
}

// ============================================================================
// Result Merging
// ============================================================================

/**
 * Merge local and RAG results, removing duplicates.
 */
export function mergeResults(
  localResults: SearchResult[],
  ragResults: SearchResult[],
  options: { ragWeight?: number } = {}
): SearchResult[] {
  const { ragWeight = 0.6 } = options;
  const localWeight = 1 - ragWeight;

  const resultMap = new Map<string, SearchResult & { sources: string[] }>();

  for (const result of localResults) {
    resultMap.set(result.id, { ...result, score: result.score * localWeight, sources: ["local"] });
  }

  for (const result of ragResults) {
    const existing = resultMap.get(result.id);
    if (existing) {
      existing.score = existing.score + result.score * ragWeight;
      existing.sources.push("rag");
    } else {
      resultMap.set(result.id, { ...result, score: result.score * ragWeight, sources: ["rag"] });
    }
  }

  return Array.from(resultMap.values())
    .toSorted((a, b) => b.score - a.score)
    .map(({ sources: _sources, ...result }) => result);
}

/**
 * Determine the source of a result.
 */
export function getResultSource(
  result: SearchResult,
  localResults: SearchResult[],
  ragResults: SearchResult[]
): "local" | "rag" | "both" {
  const inLocal = localResults.some((r) => r.id === result.id);
  const inRag = ragResults.some((r) => r.id === result.id);

  if (inLocal && inRag) return "both";
  if (inRag) return "rag";
  return "local";
}
