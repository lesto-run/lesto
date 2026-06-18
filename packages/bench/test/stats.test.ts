import { describe, expect, it } from "vitest";

import { BenchError, histogram, percentile, summarize } from "../src/index";

describe("percentile", () => {
  it("returns a value that actually occurred (nearest-rank, no interpolation)", () => {
    const samples = [10, 20, 30, 40, 50];

    expect(percentile(samples, 50)).toBe(30);
    expect(percentile(samples, 100)).toBe(50);
  });

  it("treats p=0 as the minimum (rank clamps up to 1)", () => {
    expect(percentile([5, 1, 9, 3], 0)).toBe(1);
  });

  it("sorts a defensive copy — the input order is irrelevant", () => {
    const samples = [50, 10, 40, 20, 30];

    expect(percentile(samples, 99)).toBe(50);
    // The original array is untouched.
    expect(samples).toEqual([50, 10, 40, 20, 30]);
  });

  it("computes p99 as the top sample on a 100-element set", () => {
    const samples = Array.from({ length: 100 }, (_unused, i) => i + 1);

    // ceil(0.99 * 100) = 99 → the 99th smallest (1-based) = 99.
    expect(percentile(samples, 99)).toBe(99);
  });

  it("throws BENCH_NO_SAMPLES on an empty set", () => {
    expect(() => percentile([], 50)).toThrowError(BenchError);
    try {
      percentile([], 50);
    } catch (error) {
      expect((error as BenchError).code).toBe("BENCH_NO_SAMPLES");
    }
  });

  it("throws BENCH_PERCENTILE_OUT_OF_RANGE below 0", () => {
    try {
      percentile([1, 2, 3], -1);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as BenchError).code).toBe("BENCH_PERCENTILE_OUT_OF_RANGE");
      expect((error as BenchError).details).toMatchObject({ p: -1 });
    }
  });

  it("throws BENCH_PERCENTILE_OUT_OF_RANGE above 100", () => {
    try {
      percentile([1, 2, 3], 101);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as BenchError).code).toBe("BENCH_PERCENTILE_OUT_OF_RANGE");
    }
  });
});

describe("histogram", () => {
  it("buckets samples into ascending [prev, edge) ranges plus an Infinity tail", () => {
    const buckets = histogram([1, 5, 5, 12, 100], [10, 50]);

    expect(buckets).toEqual([
      { ltMs: 10, count: 3 }, // 1, 5, 5
      { ltMs: 50, count: 1 }, // 12
      { ltMs: Number.POSITIVE_INFINITY, count: 1 }, // 100
    ]);
  });

  it("sorts and de-duplicates the boundaries before bucketing", () => {
    const buckets = histogram([2, 8, 8], [50, 10, 10]);

    expect(buckets.map((bucket) => bucket.ltMs)).toEqual([10, 50, Number.POSITIVE_INFINITY]);
    expect(buckets[0]?.count).toBe(3);
  });

  it("counts sum to the sample length, even with no samples", () => {
    const buckets = histogram([], [10]);

    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(0);
  });

  it("routes an exact boundary value up into the next bucket (strict <)", () => {
    const buckets = histogram([10], [10]);

    // 10 is NOT < 10, so it falls into the Infinity tail, not the [.., 10) bucket.
    expect(buckets[0]?.count).toBe(0);
    expect(buckets[1]?.count).toBe(1);
  });
});

describe("summarize", () => {
  it("derives throughput from count and wall-clock elapsed, not summed latency", () => {
    // 4 samples over a 2000ms window = 2 ops/sec, regardless of latencies.
    const stats = summarize([100, 100, 100, 100], 2000);

    expect(stats.count).toBe(4);
    expect(stats.throughput).toBe(2);
    expect(stats.elapsedMs).toBe(2000);
  });

  it("computes min/mean/p50/p99/max", () => {
    const stats = summarize([10, 20, 30, 40], 1000);

    expect(stats.min).toBe(10);
    expect(stats.max).toBe(40);
    expect(stats.mean).toBe(25);
    expect(stats.p50).toBe(20); // ceil(0.5*4)=2 → 2nd smallest
    expect(stats.p99).toBe(40);
  });

  it("reports throughput 0 when elapsed is non-positive (too fast to measure)", () => {
    const stats = summarize([1, 2, 3], 0);

    expect(stats.throughput).toBe(0);
  });

  it("throws BENCH_NO_SAMPLES on an empty run", () => {
    try {
      summarize([], 1000);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as BenchError).code).toBe("BENCH_NO_SAMPLES");
    }
  });
});
