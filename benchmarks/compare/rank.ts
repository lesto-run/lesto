/**
 * The cross-framework comparison renderer.
 *
 * The in-process comparisons (`ssr.ts`, `router.ts`) drive each contender through
 * the SAME `@lesto/bench` runner — same clock, same iteration count, same machine,
 * back to back — and hand the resulting {@link RunResult}s here to be ranked and
 * rendered. This module is PURE: ranking math and markdown production, no timing,
 * no I/O. That keeps the only thing that varies between contenders the code under
 * test, and keeps the honest-comparison logic unit-testable to the byte.
 *
 * "Fastest" here means highest sustained throughput on THIS machine in THIS run.
 * The harness never compares across machines or across runs — see `../README.md`.
 */

import type { RunResult } from "@lesto/bench";

/** One contender's place in a ranked comparison. */
export interface RankedRow {
  /** The contender's label (e.g. `lesto`, `react`, `find-my-way`). */
  readonly name: string;
  /** Sustained operations/second — the primary ranking key. */
  readonly throughput: number;
  /** Median per-op latency (ms). */
  readonly p50: number;
  /** Tail per-op latency (ms). */
  readonly p99: number;
  /**
   * Throughput as a fraction of the FASTEST contender's, in `(0, 1]`. The winner
   * is `1`; a contender at half the winner's throughput is `0.5`. Expresses "how
   * close to the front" without privileging the absolute number (which is
   * machine-specific noise).
   */
  readonly relative: number;
}

/**
 * Rank contenders fastest-first by throughput, annotating each with its share of
 * the leader's throughput. A tie keeps input order (a stable sort), so a
 * re-run with identical numbers renders byte-identically.
 *
 * Returns `[]` for no results. The leader's throughput is the denominator for
 * `relative`; if it is `0` (a pathologically empty run) every `relative` is `0`
 * rather than `NaN`, so the table never renders `NaN%`.
 */
export function rankByThroughput(results: readonly RunResult[]): RankedRow[] {
  if (results.length === 0) {
    return [];
  }

  const sorted = results.toSorted((a, b) => b.stats.throughput - a.stats.throughput);
  // The first row after a descending sort is the fastest; guard a zero leader so
  // `relative` is a real number, never `NaN`.
  const fastest = sorted[0]?.stats.throughput ?? 0;

  return sorted.map((result) => ({
    name: result.name,
    throughput: result.stats.throughput,
    p50: result.stats.p50,
    p99: result.stats.p99,
    relative: fastest > 0 ? result.stats.throughput / fastest : 0,
  }));
}

/** Round to two decimals for stable, diff-friendly output. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Round to four decimals for sub-millisecond latency columns. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** One comparison group: a titled set of contenders measured on the same workload. */
export interface ComparisonSection {
  /** The workload heading (e.g. "SSR render (50-row list → HTML)"). */
  readonly title: string;
  /** An optional note printed under the heading — methodology, caveats, what "win" means. */
  readonly note?: string;
  /** The contenders, in any order; rendered fastest-first. */
  readonly results: readonly RunResult[];
}

/**
 * Render one ranked section as a markdown table. The fastest row is marked, and
 * each row shows its throughput as a percentage of the leader, so a glance reads
 * the gap without parsing absolute ops/sec (which is machine-specific).
 */
export function renderSection(section: ComparisonSection): string {
  const ranked = rankByThroughput(section.results);

  const lines = [`### ${section.title}`, "", ...(section.note ? [`> ${section.note}`, ""] : [])];

  if (ranked.length === 0) {
    lines.push("_No contenders measured (all skipped)._", "");

    return lines.join("\n");
  }

  lines.push(
    "| Rank | Contender | ops/sec | % of fastest | p50 (ms) | p99 (ms) |",
    "| ---: | --- | ---: | ---: | ---: | ---: |",
  );

  ranked.forEach((row, index) => {
    const rank = index === 0 ? "🏆 1" : String(index + 1);
    lines.push(
      `| ${rank} | ${row.name} | ${round2(row.throughput)} | ` +
        `${round2(row.relative * 100)}% | ${round4(row.p50)} | ${round4(row.p99)} |`,
    );
  });

  lines.push("");

  return lines.join("\n");
}

/**
 * Render the full comparison report — a header that states, unmissably, what
 * these numbers are and are not, followed by one ranked table per workload. The
 * output is deterministic for fixed inputs so the committed copy diffs cleanly.
 */
export function renderComparison(
  sections: readonly ComparisonSection[],
  recordedAt: string,
): string {
  return [
    "# Lesto cross-framework comparison (in-process)",
    "",
    "Each contender runs the SAME workload through the SAME `@lesto/bench` runner,",
    "back-to-back on this one machine. These are **in-process micro-benchmarks**:",
    "they isolate a single code path (render, route-match) with no socket and no",
    "server, so self-vs-self noise runs tens of percent run to run. Read the",
    "_ranking_ and the _gap_, never the absolute ops/sec, and never compare across",
    "machines. For the headline request-throughput numbers, see the real-server",
    "load harness in `../driver` (run in CI / locally).",
    "",
    `_recorded: ${recordedAt}_`,
    "",
    ...sections.map(renderSection),
  ].join("\n");
}
