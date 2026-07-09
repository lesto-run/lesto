import { describe, expect, it } from "vitest";

import { replayEvictionBounds } from "../src/replay";

describe("replayEvictionBounds — the count window", () => {
  it("keeps exactly the newest maxEntries: at capacity, evicts nothing (bound ≤ 0)", () => {
    // 100 messages, keep 100 → the newest 100 are seqs 1..100, so nothing is behind them.
    // `seq <= 0` matches no row (seqs are 1-based), so the DELETE is a no-op — correct.
    expect(replayEvictionBounds(100, 0, { maxEntries: 100, maxAgeMs: 1 }).seqAtOrBelow).toBe(0);
  });

  it("evicts everything behind the newest maxEntries once capacity is exceeded", () => {
    // 101 messages, keep 100 → keep seqs 2..101, evict seq <= 1.
    expect(replayEvictionBounds(101, 0, { maxEntries: 100, maxAgeMs: 1 }).seqAtOrBelow).toBe(1);
  });

  it("evicts nothing while fewer than maxEntries messages exist (bound goes negative)", () => {
    // 3 messages, keep 100 → bound is -97; `seq <= -97` matches no row.
    expect(replayEvictionBounds(3, 0, { maxEntries: 100, maxAgeMs: 1 }).seqAtOrBelow).toBe(-97);
  });
});

describe("replayEvictionBounds — the age window", () => {
  it("evicts everything stamped before now - maxAgeMs", () => {
    // now = 10_000ms, keep the last 5s → anything with `at < 5_000` is aged out.
    expect(replayEvictionBounds(1, 10_000, { maxEntries: 1, maxAgeMs: 5_000 }).agedOutBefore).toBe(
      5_000,
    );
  });
});

describe("replayEvictionBounds — both bounds together", () => {
  it("returns the count and age bounds as independent deletes (their union is the eviction set)", () => {
    expect(replayEvictionBounds(101, 10_000, { maxEntries: 100, maxAgeMs: 5_000 })).toEqual({
      seqAtOrBelow: 1,
      agedOutBefore: 5_000,
    });
  });
});
