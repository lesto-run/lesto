import { describe, expect, it } from "vitest";

import { compareRuns } from "../src/index";

import type { ResultsByName, RunResult, Stats } from "../src/index";

/** A minimal RunResult whose only meaningful fields are throughput + p99. */
function run(name: string, throughput: number, p99: number): RunResult {
  const stats: Stats = {
    count: 1,
    throughput,
    elapsedMs: 1,
    min: 0,
    mean: p99,
    p50: p99,
    p99,
    max: p99,
  };

  return { name, iterations: 1, concurrency: 1, stats };
}

function results(...runs: RunResult[]): ResultsByName {
  return Object.fromEntries(runs.map((r) => [r.name, r]));
}

describe("compareRuns", () => {
  it("marks a workload with no baseline as new (null deltas)", () => {
    const comparison = compareRuns({}, results(run("a", 100, 10)));

    expect(comparison.deltas).toEqual([
      { name: "a", throughputDelta: null, p99Delta: null, verdict: "new" },
    ]);
    expect(comparison.regressed).toBe(false);
  });

  it("flags improvement when throughput rises and p99 holds", () => {
    const before = results(run("a", 100, 10));
    const after = results(run("a", 130, 10));

    const [delta] = compareRuns(before, after).deltas;

    expect(delta?.throughputDelta).toBeCloseTo(0.3);
    expect(delta?.p99Delta).toBe(0);
    expect(delta?.verdict).toBe("improved");
  });

  it("flags regression when p99 blows out even if throughput improved (worse vote wins)", () => {
    const before = results(run("a", 100, 10));
    const after = results(run("a", 200, 30)); // 2x throughput but 3x p99

    const comparison = compareRuns(before, after);

    expect(comparison.deltas[0]?.verdict).toBe("regressed");
    expect(comparison.regressed).toBe(true);
  });

  it("flags regression when throughput drops", () => {
    const comparison = compareRuns(results(run("a", 100, 10)), results(run("a", 50, 10)));

    expect(comparison.deltas[0]?.verdict).toBe("regressed");
  });

  it("flags improvement when p99 drops and throughput holds", () => {
    const comparison = compareRuns(results(run("a", 100, 20)), results(run("a", 100, 10)));

    expect(comparison.deltas[0]?.verdict).toBe("improved");
  });

  it("reads movement within the threshold as unchanged", () => {
    // +2% throughput, -1% p99 — both inside the default 5% slack.
    const comparison = compareRuns(results(run("a", 100, 100)), results(run("a", 102, 99)));

    expect(comparison.deltas[0]?.verdict).toBe("unchanged");
    expect(comparison.regressed).toBe(false);
  });

  it("honors a custom threshold", () => {
    // +8% throughput reads as improved under a 5% threshold but unchanged under 10%.
    const before = results(run("a", 100, 100));
    const after = results(run("a", 108, 100));

    expect(compareRuns(before, after, { thresholdPct: 0.05 }).deltas[0]?.verdict).toBe("improved");
    expect(compareRuns(before, after, { thresholdPct: 0.1 }).deltas[0]?.verdict).toBe("unchanged");
  });

  it("treats a non-positive baseline metric as no-comparison (null delta)", () => {
    // A prior run that recorded zero throughput / zero p99 cannot yield a ratio.
    const comparison = compareRuns(results(run("a", 0, 0)), results(run("a", 100, 10)));

    expect(comparison.deltas[0]?.throughputDelta).toBeNull();
    expect(comparison.deltas[0]?.p99Delta).toBeNull();
    expect(comparison.deltas[0]?.verdict).toBe("unchanged");
  });

  it("drops workloads that exist only in the baseline (current defines the shape)", () => {
    const comparison = compareRuns(
      results(run("a", 100, 10), run("gone", 5, 5)),
      results(run("a", 100, 10)),
    );

    expect(comparison.deltas).toHaveLength(1);
    expect(comparison.deltas[0]?.name).toBe("a");
  });
});
