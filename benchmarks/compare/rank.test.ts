import { describe, expect, test } from "bun:test";

import { rankByThroughput, renderComparison, renderSection } from "./rank";

import type { RunResult } from "@lesto/bench";

/** A minimal `RunResult` with just the fields the renderer reads. */
function result(name: string, throughput: number, p50 = 0.01, p99 = 0.02): RunResult {
  return {
    name,
    iterations: 100,
    concurrency: 1,
    stats: { count: 100, throughput, elapsedMs: 1, min: 0, mean: p50, p50, p99, max: p99 },
  };
}

describe("rankByThroughput", () => {
  test("orders fastest-first and annotates the share of the leader", () => {
    const ranked = rankByThroughput([result("slow", 100), result("fast", 400), result("mid", 200)]);

    expect(ranked.map((r) => r.name)).toEqual(["fast", "mid", "slow"]);
    expect(ranked.map((r) => r.relative)).toEqual([1, 0.5, 0.25]);
  });

  test("is a stable sort on ties (re-runs render identically)", () => {
    const ranked = rankByThroughput([result("a", 100), result("b", 100)]);

    expect(ranked.map((r) => r.name)).toEqual(["a", "b"]);
  });

  test("returns [] for no results", () => {
    expect(rankByThroughput([])).toEqual([]);
  });

  test("never produces NaN when the leader's throughput is 0", () => {
    const ranked = rankByThroughput([result("a", 0), result("b", 0)]);

    expect(ranked.every((r) => Number.isFinite(r.relative))).toBe(true);
    expect(ranked.map((r) => r.relative)).toEqual([0, 0]);
  });
});

describe("renderSection", () => {
  test("marks the winner and shows each contender's percentage of fastest", () => {
    const md = renderSection({
      title: "SSR",
      results: [result("react", 200), result("lesto", 100)],
    });

    expect(md).toContain("### SSR");
    expect(md).toContain("🏆 1 | react");
    expect(md).toContain("100%");
    expect(md).toContain("50%");
  });

  test("renders a note when supplied", () => {
    const md = renderSection({ title: "T", note: "a caveat", results: [result("x", 1)] });

    expect(md).toContain("> a caveat");
  });

  test("renders an explicit empty marker when every contender was skipped", () => {
    const md = renderSection({ title: "Empty", results: [] });

    expect(md).toContain("_No contenders measured (all skipped)._");
  });
});

describe("renderComparison", () => {
  test("leads with the in-process caveat and includes each section", () => {
    const md = renderComparison(
      [
        { title: "A", results: [result("x", 1)] },
        { title: "B", results: [result("y", 1)] },
      ],
      "2026-01-01T00:00:00.000Z",
    );

    expect(md).toContain("in-process micro-benchmarks");
    expect(md).toContain("never compare across");
    expect(md).toContain("### A");
    expect(md).toContain("### B");
    expect(md).toContain("_recorded: 2026-01-01T00:00:00.000Z_");
  });
});
