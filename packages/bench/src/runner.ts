/**
 * The load loop — the one piece of timing-dependent glue, kept as thin as the
 * harness allows and structured so the MEASUREMENT is injected, never baked in.
 *
 * A {@link SampleSource} is "do one unit of work and tell me nothing"; the runner
 * times each call itself with the injected `clock`, so a test drives the whole
 * loop with a fake source + a fake clock and asserts the exact samples and
 * elapsed span — no real server, no real wall clock, no flake. The real
 * workloads (HTTP, queue, SSR) are just `SampleSource`s wired in `workloads.ts`.
 */

import { BenchError } from "./errors";
import { summarize } from "./stats";

import type { Stats } from "./stats";

/**
 * One unit of work to be measured. It performs the operation and resolves; the
 * runner brackets the call to derive the latency, so the source itself never
 * touches a clock. Throwing rejects the whole run — a workload that errors is a
 * broken benchmark, not a slow one, and must surface loudly rather than skew the
 * numbers.
 */
export type SampleSource = () => Promise<void>;

/** A clock the runner brackets each sample with. Injected so tests are exact. */
export type MonotonicClock = () => number;

export interface RunOptions {
  /** A human label for the workload — appears in the report row. */
  readonly name: string;
  /** Total number of operations to run across all workers. Must be ≥ 1. */
  readonly iterations: number;
  /** How many operations run concurrently. Defaults to 1. Must be ≥ 1. */
  readonly concurrency?: number;
  /**
   * Operations to run-and-discard before measuring, to let JITs warm and caches
   * fill so the recorded numbers reflect steady state, not cold start. Defaults
   * to 0. Warmup samples are timed-and-thrown-away, never folded into the verdict.
   */
  readonly warmup?: number;
  /** The high-resolution clock to bracket each sample with. Defaults to `performance.now`. */
  readonly clock?: MonotonicClock;
}

/** A finished workload run: its label, the per-op stats, and the run shape. */
export interface RunResult {
  readonly name: string;
  readonly iterations: number;
  readonly concurrency: number;
  readonly stats: Stats;
}

const defaultClock: MonotonicClock = () => performance.now();

/**
 * Drive `source` for `iterations` measured operations across `concurrency`
 * workers and reduce the result to a {@link RunResult}.
 *
 * The loop is a fixed-size work pool: `concurrency` workers each pull from a
 * shared counter until `iterations` are claimed, so the total is exact regardless
 * of how the work divides (no leftover from `iterations / concurrency` not being
 * whole). Each worker times its own samples against the shared `clock` and pushes
 * the latency; the run's wall-clock `elapsedMs` is bracketed around the whole
 * pool, so `throughput` reflects real sustained ops/sec under contention — not
 * the sum of serial latencies.
 *
 * Throws `BENCH_EMPTY_RUN` for `iterations < 1` (nothing to measure) and
 * `BENCH_INVALID_CONCURRENCY` for `concurrency < 1` (a pool needs a worker).
 */
export async function runBench(source: SampleSource, options: RunOptions): Promise<RunResult> {
  const iterations = options.iterations;
  const concurrency = options.concurrency ?? 1;
  const warmup = options.warmup ?? 0;
  const clock = options.clock ?? defaultClock;

  if (iterations < 1) {
    throw new BenchError(
      "BENCH_EMPTY_RUN",
      `A run needs at least one iteration; got ${iterations}.`,
      { iterations },
    );
  }

  if (concurrency < 1) {
    throw new BenchError(
      "BENCH_INVALID_CONCURRENCY",
      `Concurrency must be at least 1; got ${concurrency}.`,
      { concurrency },
    );
  }

  // Warm up first: run-and-discard so a cold JIT / empty cache does not land in
  // the measured window. These are serial — warmup is about reaching steady
  // state, not about measuring contention.
  for (let i = 0; i < warmup; i += 1) {
    await source();
  }

  const samples: number[] = [];
  let claimed = 0;

  const worker = async (): Promise<void> => {
    // Each worker pulls the next index off the shared counter until the budget is
    // exhausted. The pre-increment claim is atomic in a single-threaded event
    // loop (no await between read and write), so no two workers run the same unit.
    while (claimed < iterations) {
      claimed += 1;

      const start = clock();
      await source();
      samples.push(clock() - start);
    }
  };

  const startedAt = clock();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedMs = clock() - startedAt;

  return {
    name: options.name,
    iterations,
    concurrency,
    stats: summarize(samples, elapsedMs),
  };
}
