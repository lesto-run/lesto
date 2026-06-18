/**
 * The measurement core — pure arithmetic over a list of latency samples.
 *
 * Everything here is a total function of its inputs: no clock, no I/O, no
 * randomness. That is deliberate. The load loop that PRODUCES samples is messy
 * and time-dependent; the math that TURNS samples into a verdict must not be, so
 * it lives here, alone, and is unit-tested exhaustively. A regression in p99 is a
 * regression we can reproduce from a fixed array — never "it was a slow machine."
 */

import { BenchError } from "./errors";

/** One observation: how long a single operation took, in milliseconds. */
export type LatencyMs = number;

/** The distilled verdict for one workload run. */
export interface Stats {
  /** How many operations were measured. */
  readonly count: number;
  /** Operations per second, derived from `count` and the wall-clock `elapsedMs`. */
  readonly throughput: number;
  /** Total wall-clock time the run took, in milliseconds. */
  readonly elapsedMs: number;
  /** The fastest single operation, in milliseconds. */
  readonly min: LatencyMs;
  /** The arithmetic mean latency, in milliseconds. */
  readonly mean: LatencyMs;
  /** The median (p50) latency, in milliseconds. */
  readonly p50: LatencyMs;
  /** The 99th-percentile latency, in milliseconds — the headline tail signal. */
  readonly p99: LatencyMs;
  /** The slowest single operation, in milliseconds. */
  readonly max: LatencyMs;
}

/**
 * The `p`-th percentile of `samples`, by the nearest-rank method on a sorted copy.
 *
 * Nearest-rank (not linear interpolation) is chosen on purpose: it always returns
 * a value that ACTUALLY OCCURRED in the sample set, so a reported p99 is a real
 * latency some operation really paid — not a synthetic blend between two
 * neighbours. For a benchmark verdict that is the honest number.
 *
 * The rank is `ceil(p/100 * n)`, clamped into `[1, n]`, then read 1-based. `p = 0`
 * yields the minimum (rank clamps up to 1); `p = 100` yields the maximum.
 *
 * Throws `BENCH_NO_SAMPLES` on an empty set (a percentile of nothing is
 * undefined) and `BENCH_PERCENTILE_OUT_OF_RANGE` for `p` outside `[0, 100]`.
 */
export function percentile(samples: readonly LatencyMs[], p: number): LatencyMs {
  if (samples.length === 0) {
    throw new BenchError("BENCH_NO_SAMPLES", "Cannot take a percentile of an empty sample set.");
  }

  if (p < 0 || p > 100) {
    throw new BenchError(
      "BENCH_PERCENTILE_OUT_OF_RANGE",
      `Percentile must be within [0, 100]; got ${p}.`,
      { p },
    );
  }

  const sorted = samples.toSorted((a, b) => a - b);

  // Nearest-rank: rank ∈ [1, n], read 1-based. `Math.ceil(0)` is 0, so `p = 0`
  // would index -1 without the lower clamp; the upper clamp guards rounding at
  // `p = 100`. The non-null assertion is sound — `rank - 1` is a valid index by
  // construction (1 ≤ rank ≤ n), but `noUncheckedIndexedAccess` cannot prove it.
  const rank = Math.min(Math.max(Math.ceil((p / 100) * sorted.length), 1), sorted.length);

  return sorted[rank - 1] as LatencyMs;
}

/**
 * Reduce a run's raw latency samples + its wall-clock duration into a {@link Stats}
 * verdict. `elapsedMs` is the measured wall-clock span of the whole run (NOT the
 * sum of sample latencies — under concurrency those overlap), so `throughput` is
 * the true ops/sec the harness sustained.
 *
 * Throws `BENCH_NO_SAMPLES` on an empty set: a run that produced no observations
 * has no verdict to give, and silently returning zeros would hide a broken
 * workload behind a plausible-looking row.
 */
export function summarize(samples: readonly LatencyMs[], elapsedMs: number): Stats {
  if (samples.length === 0) {
    throw new BenchError("BENCH_NO_SAMPLES", "Cannot summarize a run with no samples.");
  }

  const count = samples.length;
  const total = samples.reduce((sum, sample) => sum + sample, 0);

  // Guard the degenerate `elapsedMs <= 0` (a run so fast the clock did not move,
  // or a stubbed zero): a finite throughput needs a positive denominator, and
  // dividing by zero would report `Infinity` ops/sec. Fall back to 0 — "too fast
  // to measure" is reported as unknown, never as infinitely fast.
  const throughput = elapsedMs > 0 ? (count / elapsedMs) * 1000 : 0;

  return {
    count,
    throughput,
    elapsedMs,
    min: Math.min(...samples),
    mean: total / count,
    p50: percentile(samples, 50),
    p99: percentile(samples, 99),
    max: Math.max(...samples),
  };
}
