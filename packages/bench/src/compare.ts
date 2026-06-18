/**
 * Regression compare — the trend half of "record results so trends are visible
 * across runs." Pure: given the previous run's recorded results and the current
 * run's, it computes per-workload deltas and flags regressions against a
 * threshold. No I/O; the bin reads the old JSON off disk and hands it here.
 */

import type { RunResult } from "./runner";

/** A run's results keyed by workload name — what we record and diff. */
export type ResultsByName = Readonly<Record<string, RunResult>>;

/** The direction a metric "improves" in. Throughput up is good; latency down is good. */
export type Verdict = "improved" | "regressed" | "unchanged" | "new";

/** One workload's change between the baseline run and the current run. */
export interface WorkloadDelta {
  readonly name: string;
  /** Fractional change in throughput, e.g. `+0.12` for a 12% gain. `null` when new. */
  readonly throughputDelta: number | null;
  /** Fractional change in p99 latency, e.g. `-0.05` for a 5% improvement. `null` when new. */
  readonly p99Delta: number | null;
  readonly verdict: Verdict;
}

/** The full comparison: one delta per workload in the current run, plus a roll-up. */
export interface Comparison {
  readonly deltas: readonly WorkloadDelta[];
  /** True iff ANY workload regressed beyond `thresholdPct` — the CI gate signal. */
  readonly regressed: boolean;
}

export interface CompareOptions {
  /**
   * The fractional slack a metric may move before it counts as a real change,
   * e.g. `0.05` = ±5%. Below it, a workload reads `unchanged` — benchmark noise
   * should not flap a verdict. Defaults to `0.05`.
   */
  readonly thresholdPct?: number;
}

/** Fractional change `(now - was) / was`, or `null` when there is no baseline to divide by. */
function fractionalChange(was: number, now: number): number | null {
  // A zero (or non-positive) baseline has no defined ratio — `(now - 0) / 0` is
  // `Infinity`/`NaN`. Treat it as "no comparable baseline" so a degenerate prior
  // run never poisons the verdict with an infinite delta.
  if (was <= 0) {
    return null;
  }

  return (now - was) / was;
}

/**
 * Classify one workload's movement. Throughput and p99 pull in OPPOSITE
 * directions — more ops/sec is better, more tail latency is worse — so the
 * verdict reads throughput's sign directly and p99's inverted. The WORSE of the
 * two wins: a run that gained throughput but blew out its p99 still `regressed`,
 * because the tail is the signal a benchmark exists to protect.
 */
function classify(
  throughputDelta: number | null,
  p99Delta: number | null,
  threshold: number,
): Verdict {
  // A metric with no baseline (`null`) contributes nothing to the verdict; only
  // metrics we can actually compare vote.
  const throughputVote: Verdict =
    throughputDelta === null || Math.abs(throughputDelta) < threshold
      ? "unchanged"
      : throughputDelta > 0
        ? "improved"
        : "regressed";

  const p99Vote: Verdict =
    p99Delta === null || Math.abs(p99Delta) < threshold
      ? "unchanged"
      : p99Delta < 0
        ? "improved"
        : "regressed";

  // The worse vote wins: any regression dominates, then any improvement, else
  // unchanged. This is the order a release gate cares about — one regressed
  // metric is a regressed workload regardless of the other.
  if (throughputVote === "regressed" || p99Vote === "regressed") {
    return "regressed";
  }

  if (throughputVote === "improved" || p99Vote === "improved") {
    return "improved";
  }

  return "unchanged";
}

/**
 * Diff `current` against `baseline`, workload by workload. A workload present in
 * `current` but absent from `baseline` is `new` (no comparison possible);
 * workloads only in `baseline` are dropped — the current run defines the shape of
 * the report. The roll-up `regressed` is true iff any workload regressed, so a CI
 * gate can branch on a single boolean.
 */
export function compareRuns(
  baseline: ResultsByName,
  current: ResultsByName,
  options: CompareOptions = {},
): Comparison {
  const threshold = options.thresholdPct ?? 0.05;

  const deltas = Object.values(current).map<WorkloadDelta>((run) => {
    const prior = baseline[run.name];

    if (prior === undefined) {
      return { name: run.name, throughputDelta: null, p99Delta: null, verdict: "new" };
    }

    const throughputDelta = fractionalChange(prior.stats.throughput, run.stats.throughput);
    const p99Delta = fractionalChange(prior.stats.p99, run.stats.p99);

    return {
      name: run.name,
      throughputDelta,
      p99Delta,
      verdict: classify(throughputDelta, p99Delta, threshold),
    };
  });

  return { deltas, regressed: deltas.some((delta) => delta.verdict === "regressed") };
}
