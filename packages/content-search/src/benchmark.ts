/**
 * Search Quality Benchmark Suite
 *
 * Measures search quality using standard IR metrics:
 * - Precision@K: How many returned results are relevant?
 * - Recall@K: How many relevant docs were returned?
 * - NDCG@K: Ranking quality (higher relevance should rank higher)
 * - MRR: Mean Reciprocal Rank (position of first relevant result)
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Relevance scale for benchmark queries.
 */
export enum Relevance {
  /** Not relevant (score: 0) */
  NOT_RELEVANT = 0,
  /** Somewhat relevant, related topic (score: 1) */
  SOMEWHAT_RELEVANT = 1,
  /** Highly relevant, answers the question (score: 2) */
  HIGHLY_RELEVANT = 2,
  /** Perfect match, exactly what user wants (score: 3) */
  PERFECT = 3,
}

/**
 * Query category for difficulty classification.
 */
export type QueryCategory =
  | "exact_keyword"
  | "partial_keyword"
  | "synonym"
  | "typo"
  | "conceptual"
  | "multi_intent";

/**
 * A benchmark query with expected relevant documents.
 */
export interface BenchmarkQuery {
  /** Unique query ID */
  id: string;
  /** The search query string */
  query: string;
  /** Query category for difficulty tracking */
  category?: QueryCategory | undefined;
  /** Expected relevant documents with relevance scores */
  relevantDocs: Array<{
    /** Document ID */
    id: string;
    /** Relevance score (0-3) */
    relevance: Relevance | number;
  }>;
}

/**
 * A benchmark dataset containing multiple queries.
 */
export interface BenchmarkDataset {
  /** Dataset name */
  name: string;
  /** Dataset description */
  description?: string;
  /** Benchmark queries */
  queries: BenchmarkQuery[];
  /** When the dataset was created */
  createdAt: string;
}

/**
 * Result of a single query in the benchmark.
 */
export interface QueryBenchmarkResult {
  /** Query ID */
  queryId: string;
  /** Query string */
  query: string;
  /** Query category */
  category?: QueryCategory | undefined;
  /** Search latency in milliseconds */
  latencyMs: number;
  /** IDs of returned results in order */
  returnedIds: string[];
  /** Expected relevant docs */
  expectedDocs: Array<{ id: string; relevance: number }>;
  /** Per-query metrics */
  metrics: {
    precision1: number;
    precision5: number;
    precision10: number;
    recall1: number;
    recall5: number;
    recall10: number;
    ndcg5: number;
    ndcg10: number;
    reciprocalRank: number;
    hasResults: boolean;
  };
}

/**
 * Quality metrics aggregated across all queries.
 */
export interface QualityMetrics {
  /** Precision at K (fraction of returned results that are relevant) */
  precisionAtK: {
    k1: number;
    k5: number;
    k10: number;
  };
  /** Recall at K (fraction of relevant docs that were returned) */
  recallAtK: {
    k1: number;
    k5: number;
    k10: number;
  };
  /** Normalized Discounted Cumulative Gain (ranking quality) */
  ndcgAtK: {
    k5: number;
    k10: number;
  };
  /** Mean Reciprocal Rank (1 / position of first relevant result) */
  meanReciprocalRank: number;
  /** Fraction of queries with zero results */
  zeroResultRate: number;
}

/**
 * Performance metrics from the benchmark run.
 */
export interface PerformanceMetrics {
  /** Total queries executed */
  totalQueries: number;
  /** Latency percentiles in milliseconds */
  latency: {
    p50: number;
    p95: number;
    p99: number;
    mean: number;
    max: number;
  };
}

/**
 * Complete benchmark report.
 */
export interface BenchmarkReport {
  /** Dataset used */
  dataset: {
    name: string;
    queryCount: number;
  };
  /** Quality metrics */
  quality: QualityMetrics;
  /** Performance metrics */
  performance: PerformanceMetrics;
  /** Per-category breakdown */
  byCategory: Record<QueryCategory, QualityMetrics | undefined>;
  /** Individual query results */
  results: QueryBenchmarkResult[];
  /** Timestamp of benchmark run */
  runAt: string;
  /** Duration of benchmark in milliseconds */
  durationMs: number;
}

/**
 * Search function signature for benchmarking.
 */
export type SearchFunction = (
  query: string
) => Promise<Array<{ id: string; score?: number }>>;

// ============================================================================
// Metrics Computation
// ============================================================================

/**
 * Compute precision at K.
 */
function computePrecisionAtK(
  returnedIds: string[],
  relevantIds: Set<string>,
  k: number
): number {
  const topK = returnedIds.slice(0, k);
  if (topK.length === 0) return 0;

  const relevantInTopK = topK.filter((id) => relevantIds.has(id)).length;
  return relevantInTopK / topK.length;
}

/**
 * Compute recall at K.
 */
function computeRecallAtK(
  returnedIds: string[],
  relevantIds: Set<string>,
  k: number
): number {
  if (relevantIds.size === 0) return 1;

  const topK = returnedIds.slice(0, k);
  const relevantInTopK = topK.filter((id) => relevantIds.has(id)).length;
  return relevantInTopK / relevantIds.size;
}

/**
 * Compute Normalized Discounted Cumulative Gain at K.
 */
function computeNDCGAtK(
  returnedIds: string[],
  relevanceMap: Map<string, number>,
  k: number
): number {
  const topK = returnedIds.slice(0, k);

  const dcg = topK.reduce((sum, id, i) => {
    const relevance = relevanceMap.get(id) ?? 0;
    return sum + relevance / Math.log2(i + 2);
  }, 0);

  const idealRelevances = [...relevanceMap.values()]
    .toSorted((a, b) => b - a)
    .slice(0, k);

  const idcg = idealRelevances.reduce((sum, rel, i) => {
    return sum + rel / Math.log2(i + 2);
  }, 0);

  if (idcg === 0) return 1;
  return dcg / idcg;
}

/**
 * Compute reciprocal rank.
 */
function computeReciprocalRank(
  returnedIds: string[],
  relevantIds: Set<string>
): number {
  const firstRelevantIndex = returnedIds.findIndex((id) => relevantIds.has(id));
  if (firstRelevantIndex === -1) return 0;
  return 1 / (firstRelevantIndex + 1);
}

/**
 * Compute percentile from sorted array.
 */
function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, index)]!;
}

// ============================================================================
// Benchmark Runner
// ============================================================================

/**
 * Run a search quality benchmark.
 */
export async function runBenchmark(
  searchFn: SearchFunction,
  dataset: BenchmarkDataset
): Promise<BenchmarkReport> {
  const startTime = performance.now();
  const results: QueryBenchmarkResult[] = [];

  for (const benchQuery of dataset.queries) {
    const relevantIds = new Set(benchQuery.relevantDocs.map((d) => d.id));
    const relevanceMap = new Map(
      benchQuery.relevantDocs.map((d) => [d.id, d.relevance])
    );

    const searchStart = performance.now();
    const searchResults = await searchFn(benchQuery.query);
    const latencyMs = performance.now() - searchStart;

    const returnedIds = searchResults.map((r) => r.id);

    const metrics = {
      precision1: computePrecisionAtK(returnedIds, relevantIds, 1),
      precision5: computePrecisionAtK(returnedIds, relevantIds, 5),
      precision10: computePrecisionAtK(returnedIds, relevantIds, 10),
      recall1: computeRecallAtK(returnedIds, relevantIds, 1),
      recall5: computeRecallAtK(returnedIds, relevantIds, 5),
      recall10: computeRecallAtK(returnedIds, relevantIds, 10),
      ndcg5: computeNDCGAtK(returnedIds, relevanceMap, 5),
      ndcg10: computeNDCGAtK(returnedIds, relevanceMap, 10),
      reciprocalRank: computeReciprocalRank(returnedIds, relevantIds),
      hasResults: returnedIds.length > 0,
    };

    results.push({
      queryId: benchQuery.id,
      query: benchQuery.query,
      category: benchQuery.category,
      latencyMs,
      returnedIds,
      expectedDocs: benchQuery.relevantDocs.map((d) => ({
        id: d.id,
        relevance: d.relevance,
      })),
      metrics,
    });
  }

  const durationMs = performance.now() - startTime;
  const quality = aggregateQualityMetrics(results);
  const performance_metrics = computePerformanceMetrics(results);
  const byCategory = computeMetricsByCategory(results);

  return {
    dataset: {
      name: dataset.name,
      queryCount: dataset.queries.length,
    },
    quality,
    performance: performance_metrics,
    byCategory,
    results,
    runAt: new Date().toISOString(),
    durationMs,
  };
}

/**
 * Aggregate quality metrics across all queries.
 */
function aggregateQualityMetrics(results: QueryBenchmarkResult[]): QualityMetrics {
  if (results.length === 0) {
    return {
      precisionAtK: { k1: 0, k5: 0, k10: 0 },
      recallAtK: { k1: 0, k5: 0, k10: 0 },
      ndcgAtK: { k5: 0, k10: 0 },
      meanReciprocalRank: 0,
      zeroResultRate: 1,
    };
  }

  const n = results.length;

  const sumMetrics = results.reduce(
    (acc, r) => ({
      precision1: acc.precision1 + r.metrics.precision1,
      precision5: acc.precision5 + r.metrics.precision5,
      precision10: acc.precision10 + r.metrics.precision10,
      recall1: acc.recall1 + r.metrics.recall1,
      recall5: acc.recall5 + r.metrics.recall5,
      recall10: acc.recall10 + r.metrics.recall10,
      ndcg5: acc.ndcg5 + r.metrics.ndcg5,
      ndcg10: acc.ndcg10 + r.metrics.ndcg10,
      reciprocalRank: acc.reciprocalRank + r.metrics.reciprocalRank,
      zeroResults: acc.zeroResults + (r.metrics.hasResults ? 0 : 1),
    }),
    {
      precision1: 0,
      precision5: 0,
      precision10: 0,
      recall1: 0,
      recall5: 0,
      recall10: 0,
      ndcg5: 0,
      ndcg10: 0,
      reciprocalRank: 0,
      zeroResults: 0,
    }
  );

  return {
    precisionAtK: {
      k1: sumMetrics.precision1 / n,
      k5: sumMetrics.precision5 / n,
      k10: sumMetrics.precision10 / n,
    },
    recallAtK: {
      k1: sumMetrics.recall1 / n,
      k5: sumMetrics.recall5 / n,
      k10: sumMetrics.recall10 / n,
    },
    ndcgAtK: {
      k5: sumMetrics.ndcg5 / n,
      k10: sumMetrics.ndcg10 / n,
    },
    meanReciprocalRank: sumMetrics.reciprocalRank / n,
    zeroResultRate: sumMetrics.zeroResults / n,
  };
}

/**
 * Compute performance metrics from results.
 */
function computePerformanceMetrics(
  results: QueryBenchmarkResult[]
): PerformanceMetrics {
  if (results.length === 0) {
    return {
      totalQueries: 0,
      latency: { p50: 0, p95: 0, p99: 0, mean: 0, max: 0 },
    };
  }

  const latencies = results.map((r) => r.latencyMs).toSorted((a, b) => a - b);
  const totalLatency = latencies.reduce((sum, l) => sum + l, 0);

  return {
    totalQueries: results.length,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      mean: totalLatency / results.length,
      max: latencies[latencies.length - 1]!,
    },
  };
}

/**
 * Compute metrics by query category.
 */
function computeMetricsByCategory(
  results: QueryBenchmarkResult[]
): Record<QueryCategory, QualityMetrics | undefined> {
  const categories: QueryCategory[] = [
    "exact_keyword",
    "partial_keyword",
    "synonym",
    "typo",
    "conceptual",
    "multi_intent",
  ];

  const byCategory: Record<QueryCategory, QualityMetrics | undefined> = {
    exact_keyword: undefined,
    partial_keyword: undefined,
    synonym: undefined,
    typo: undefined,
    conceptual: undefined,
    multi_intent: undefined,
  };

  for (const category of categories) {
    const categoryResults = results.filter((r) => r.category === category);
    if (categoryResults.length > 0) {
      byCategory[category] = aggregateQualityMetrics(categoryResults);
    }
  }

  return byCategory;
}

// ============================================================================
// Dataset Creation
// ============================================================================

/**
 * Create a benchmark dataset from simplified query definitions.
 */
export function createBenchmarkDataset(
  queries: Array<{
    query: string;
    relevantDocs: Array<string | { id: string; relevance?: number }>;
    category?: QueryCategory;
  }>,
  name = "Custom Benchmark"
): BenchmarkDataset {
  return {
    name,
    description: `Benchmark with ${queries.length} queries`,
    queries: queries.map((q, i) => ({
      id: `q${String(i + 1).padStart(3, "0")}`,
      query: q.query,
      category: q.category,
      relevantDocs: q.relevantDocs.map((doc) => {
        if (typeof doc === "string") {
          return { id: doc, relevance: Relevance.HIGHLY_RELEVANT };
        }
        return { id: doc.id, relevance: doc.relevance ?? Relevance.HIGHLY_RELEVANT };
      }),
    })),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Sample benchmark dataset for documentation search.
 */
export const SAMPLE_DOC_BENCHMARK: BenchmarkDataset = {
  name: "Documentation Search Benchmark",
  description: "Standard benchmark for documentation search quality",
  queries: [
    {
      id: "q001",
      query: "authentication",
      category: "exact_keyword",
      relevantDocs: [
        { id: "auth-guide", relevance: 3 },
        { id: "oauth-setup", relevance: 2 },
        { id: "jwt-tokens", relevance: 2 },
      ],
    },
    {
      id: "q002",
      query: "API reference",
      category: "exact_keyword",
      relevantDocs: [
        { id: "api-reference", relevance: 3 },
        { id: "api-overview", relevance: 2 },
      ],
    },
    {
      id: "q003",
      query: "auth",
      category: "partial_keyword",
      relevantDocs: [
        { id: "auth-guide", relevance: 3 },
        { id: "oauth-setup", relevance: 2 },
        { id: "authorization", relevance: 2 },
      ],
    },
    {
      id: "q004",
      query: "config",
      category: "partial_keyword",
      relevantDocs: [
        { id: "configuration", relevance: 3 },
        { id: "config-reference", relevance: 2 },
      ],
    },
    {
      id: "q005",
      query: "login",
      category: "synonym",
      relevantDocs: [
        { id: "auth-guide", relevance: 3 },
        { id: "user-sessions", relevance: 2 },
      ],
    },
    {
      id: "q006",
      query: "deploy",
      category: "synonym",
      relevantDocs: [
        { id: "deployment-guide", relevance: 3 },
        { id: "publishing", relevance: 2 },
        { id: "release-process", relevance: 2 },
      ],
    },
    {
      id: "q007",
      query: "authentcation",
      category: "typo",
      relevantDocs: [
        { id: "auth-guide", relevance: 3 },
        { id: "oauth-setup", relevance: 2 },
      ],
    },
    {
      id: "q008",
      query: "configration",
      category: "typo",
      relevantDocs: [
        { id: "configuration", relevance: 3 },
        { id: "config-reference", relevance: 2 },
      ],
    },
    {
      id: "q009",
      query: "how to protect my API",
      category: "conceptual",
      relevantDocs: [
        { id: "rate-limiting", relevance: 3 },
        { id: "auth-guide", relevance: 2 },
        { id: "api-security", relevance: 3 },
      ],
    },
    {
      id: "q010",
      query: "getting started",
      category: "conceptual",
      relevantDocs: [
        { id: "quickstart", relevance: 3 },
        { id: "installation", relevance: 2 },
        { id: "tutorial", relevance: 2 },
      ],
    },
    {
      id: "q011",
      query: "deploy nextjs to vercel with env vars",
      category: "multi_intent",
      relevantDocs: [
        { id: "nextjs-deployment", relevance: 3 },
        { id: "vercel-guide", relevance: 2 },
        { id: "environment-variables", relevance: 2 },
      ],
    },
    {
      id: "q012",
      query: "setup oauth with google and facebook",
      category: "multi_intent",
      relevantDocs: [
        { id: "oauth-setup", relevance: 3 },
        { id: "google-auth", relevance: 2 },
        { id: "facebook-auth", relevance: 2 },
        { id: "social-login", relevance: 2 },
      ],
    },
  ],
  createdAt: new Date().toISOString(),
};

// ============================================================================
// Quality Gates
// ============================================================================

/**
 * Quality thresholds for search benchmarks.
 */
export interface QualityThresholds {
  minRecall10: number;
  minPrecision10: number;
  minNdcg10: number;
  minMrr: number;
  maxZeroResultRate: number;
  maxP95LatencyMs: number;
}

/**
 * Default quality thresholds.
 */
export const DEFAULT_THRESHOLDS: QualityThresholds = {
  minRecall10: 0.85,
  minPrecision10: 0.70,
  minNdcg10: 0.70,
  minMrr: 0.60,
  maxZeroResultRate: 0.10,
  maxP95LatencyMs: 50,
};

/**
 * Strict quality thresholds for production.
 */
export const STRICT_THRESHOLDS: QualityThresholds = {
  minRecall10: 0.90,
  minPrecision10: 0.80,
  minNdcg10: 0.80,
  minMrr: 0.75,
  maxZeroResultRate: 0.05,
  maxP95LatencyMs: 20,
};

/**
 * Check if benchmark results meet quality thresholds.
 */
export function checkQualityGates(
  report: BenchmarkReport,
  thresholds: QualityThresholds = DEFAULT_THRESHOLDS
): {
  passed: boolean;
  failures: string[];
} {
  const failures: string[] = [];

  if (report.quality.recallAtK.k10 < thresholds.minRecall10) {
    failures.push(
      `Recall@10 ${(report.quality.recallAtK.k10 * 100).toFixed(1)}% < ${(thresholds.minRecall10 * 100).toFixed(1)}%`
    );
  }

  if (report.quality.precisionAtK.k10 < thresholds.minPrecision10) {
    failures.push(
      `Precision@10 ${(report.quality.precisionAtK.k10 * 100).toFixed(1)}% < ${(thresholds.minPrecision10 * 100).toFixed(1)}%`
    );
  }

  if (report.quality.ndcgAtK.k10 < thresholds.minNdcg10) {
    failures.push(
      `NDCG@10 ${(report.quality.ndcgAtK.k10 * 100).toFixed(1)}% < ${(thresholds.minNdcg10 * 100).toFixed(1)}%`
    );
  }

  if (report.quality.meanReciprocalRank < thresholds.minMrr) {
    failures.push(
      `MRR ${(report.quality.meanReciprocalRank * 100).toFixed(1)}% < ${(thresholds.minMrr * 100).toFixed(1)}%`
    );
  }

  if (report.quality.zeroResultRate > thresholds.maxZeroResultRate) {
    failures.push(
      `Zero result rate ${(report.quality.zeroResultRate * 100).toFixed(1)}% > ${(thresholds.maxZeroResultRate * 100).toFixed(1)}%`
    );
  }

  if (report.performance.latency.p95 > thresholds.maxP95LatencyMs) {
    failures.push(
      `P95 latency ${report.performance.latency.p95.toFixed(1)}ms > ${thresholds.maxP95LatencyMs}ms`
    );
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Format benchmark report as a readable string.
 */
export function formatBenchmarkReport(report: BenchmarkReport): string {
  const lines: string[] = [];

  lines.push(`# Search Quality Benchmark Report`);
  lines.push(``);
  lines.push(`Dataset: ${report.dataset.name} (${report.dataset.queryCount} queries)`);
  lines.push(`Run at: ${report.runAt}`);
  lines.push(`Duration: ${report.durationMs.toFixed(0)}ms`);
  lines.push(``);

  lines.push(`## Quality Metrics`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Recall@1 | ${(report.quality.recallAtK.k1 * 100).toFixed(1)}% |`);
  lines.push(`| Recall@5 | ${(report.quality.recallAtK.k5 * 100).toFixed(1)}% |`);
  lines.push(`| Recall@10 | ${(report.quality.recallAtK.k10 * 100).toFixed(1)}% |`);
  lines.push(`| Precision@1 | ${(report.quality.precisionAtK.k1 * 100).toFixed(1)}% |`);
  lines.push(`| Precision@5 | ${(report.quality.precisionAtK.k5 * 100).toFixed(1)}% |`);
  lines.push(`| Precision@10 | ${(report.quality.precisionAtK.k10 * 100).toFixed(1)}% |`);
  lines.push(`| NDCG@5 | ${(report.quality.ndcgAtK.k5 * 100).toFixed(1)}% |`);
  lines.push(`| NDCG@10 | ${(report.quality.ndcgAtK.k10 * 100).toFixed(1)}% |`);
  lines.push(`| MRR | ${(report.quality.meanReciprocalRank * 100).toFixed(1)}% |`);
  lines.push(`| Zero Result Rate | ${(report.quality.zeroResultRate * 100).toFixed(1)}% |`);
  lines.push(``);

  lines.push(`## Performance Metrics`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| P50 Latency | ${report.performance.latency.p50.toFixed(1)}ms |`);
  lines.push(`| P95 Latency | ${report.performance.latency.p95.toFixed(1)}ms |`);
  lines.push(`| P99 Latency | ${report.performance.latency.p99.toFixed(1)}ms |`);
  lines.push(`| Mean Latency | ${report.performance.latency.mean.toFixed(1)}ms |`);
  lines.push(`| Max Latency | ${report.performance.latency.max.toFixed(1)}ms |`);
  lines.push(``);

  const gateCheck = checkQualityGates(report);
  lines.push(`## Quality Gates`);
  lines.push(``);
  if (gateCheck.passed) {
    lines.push(`All quality gates passed`);
  } else {
    lines.push(`Quality gates failed:`);
    for (const failure of gateCheck.failures) {
      lines.push(`  - ${failure}`);
    }
  }

  return lines.join("\n");
}
