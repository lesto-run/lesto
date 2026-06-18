import { describe, expect, it } from "vitest";

import { BenchError, runBench } from "../src/index";

import type { MonotonicClock, SampleSource } from "../src/index";

/**
 * A scripted monotonic clock: each call returns the next value off a list, so a
 * test asserts the EXACT latencies and elapsed span the runner derives — no real
 * `performance.now`, no flake.
 */
function scriptedClock(ticks: readonly number[]): MonotonicClock {
  let i = 0;

  return () => {
    const value = ticks[i] ?? ticks[ticks.length - 1] ?? 0;
    i += 1;

    return value as number;
  };
}

/** A sample source that always throws — to assert the runner rejects, not swallows. */
const boom: SampleSource = async () => {
  throw new BenchError("BENCH_EMPTY_RUN", "workload blew up");
};

describe("runBench", () => {
  it("times each sample against the injected clock and summarizes the run", async () => {
    // Clock order for 2 serial iterations (concurrency 1):
    //   startedAt=0, [start=0,end=5], [start=5,end=12], elapsed-end=12
    const clock = scriptedClock([0, 0, 5, 5, 12, 12]);
    let calls = 0;
    const source: SampleSource = async () => {
      calls += 1;
    };

    const result = await runBench(source, { name: "x", iterations: 2, clock });

    expect(calls).toBe(2);
    expect(result.name).toBe("x");
    expect(result.iterations).toBe(2);
    expect(result.concurrency).toBe(1);
    expect(result.stats.count).toBe(2);
    // Latencies were 5 and 7.
    expect(result.stats.min).toBe(5);
    expect(result.stats.max).toBe(7);
  });

  it("runs warmup operations before measuring and excludes them from the verdict", async () => {
    const seen: string[] = [];
    let phase = "warmup";
    const source: SampleSource = async () => {
      seen.push(phase);
    };

    const result = await runBench(source, {
      name: "warm",
      iterations: 3,
      warmup: 2,
      // After the 2 warmup calls, flip the phase so measured calls are tagged.
      clock: (() => {
        let t = 0;

        return () => {
          if (seen.length >= 2) {
            phase = "measured";
          }

          return (t += 1);
        };
      })(),
    });

    expect(seen.filter((p) => p === "warmup")).toHaveLength(2);
    // Exactly `iterations` measured samples survive into the verdict.
    expect(result.stats.count).toBe(3);
  });

  it("claims an exact total across concurrent workers (no over/under-run)", async () => {
    let calls = 0;
    const source: SampleSource = async () => {
      calls += 1;
      // Yield so the pool actually interleaves workers.
      await Promise.resolve();
    };

    const result = await runBench(source, { name: "pool", iterations: 7, concurrency: 3 });

    expect(calls).toBe(7);
    expect(result.stats.count).toBe(7);
    expect(result.concurrency).toBe(3);
  });

  it("defaults concurrency to 1 and warmup to 0", async () => {
    let calls = 0;
    const result = await runBench(
      async () => {
        calls += 1;
      },
      { name: "d", iterations: 1 },
    );

    expect(calls).toBe(1);
    expect(result.concurrency).toBe(1);
  });

  it("uses the real performance clock when none is injected", async () => {
    const result = await runBench(async () => {}, { name: "real", iterations: 1 });

    expect(result.stats.count).toBe(1);
    expect(result.stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("throws BENCH_EMPTY_RUN for iterations below 1", async () => {
    await expect(runBench(async () => {}, { name: "z", iterations: 0 })).rejects.toMatchObject({
      code: "BENCH_EMPTY_RUN",
    });
  });

  it("throws BENCH_INVALID_CONCURRENCY for concurrency below 1", async () => {
    await expect(
      runBench(async () => {}, { name: "z", iterations: 1, concurrency: 0 }),
    ).rejects.toMatchObject({ code: "BENCH_INVALID_CONCURRENCY" });
  });

  it("propagates a throwing sample source as a rejected run", async () => {
    await expect(runBench(boom, { name: "boom", iterations: 1 })).rejects.toBeInstanceOf(
      BenchError,
    );
  });
});
