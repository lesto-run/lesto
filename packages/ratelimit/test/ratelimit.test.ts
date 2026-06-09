import { beforeEach, describe, expect, it } from "vitest";

import { MemoryRateLimitStore, RateLimiter, systemClock } from "../src/index";

import type { RateLimitStore } from "../src/index";

// A clock we can stop, so every refill path is deterministic.
let now: number;
const clock = (): number => now;
const advance = (ms: number): void => {
  now += ms;
};

let store: RateLimitStore;

beforeEach(() => {
  now = 1_700_000_000_000;
  store = new MemoryRateLimitStore();
});

describe("MemoryRateLimitStore", () => {
  it("round-trips bucket state and reports misses as undefined", () => {
    expect(store.get("missing")).toBeUndefined();

    store.set("k", { tokens: 3, updatedAt: now });

    expect(store.get("k")).toEqual({ tokens: 3, updatedAt: now });
  });
});

describe("RateLimiter.check", () => {
  it("allows the first check from a full bucket", () => {
    const limiter = new RateLimiter({ store, capacity: 5, refillPerSecond: 1, clock });

    const result = limiter.check("user");

    expect(result).toEqual({ allowed: true, remaining: 4, retryAfterMs: 0 });
  });

  it("exhausts the bucket, then denies with a positive retryAfterMs", () => {
    const limiter = new RateLimiter({ store, capacity: 3, refillPerSecond: 2, clock });

    expect(limiter.check("user").allowed).toBe(true); // 3 -> 2
    expect(limiter.check("user").allowed).toBe(true); // 2 -> 1
    expect(limiter.check("user").allowed).toBe(true); // 1 -> 0

    const denied = limiter.check("user");

    // Deficit of 1 token at 2 tokens/sec => 500ms to accrue.
    expect(denied).toEqual({ allowed: false, remaining: 0, retryAfterMs: 500 });
  });

  it("leaves remaining unchanged when it denies", () => {
    const limiter = new RateLimiter({ store, capacity: 1, refillPerSecond: 1, clock });

    expect(limiter.check("user").allowed).toBe(true); // 1 -> 0

    const first = limiter.check("user");
    const second = limiter.check("user");

    expect(first.remaining).toBe(0);
    expect(second.remaining).toBe(0);
  });

  it("refills as the clock advances and re-allows", () => {
    const limiter = new RateLimiter({ store, capacity: 2, refillPerSecond: 1, clock });

    expect(limiter.check("user").allowed).toBe(true); // 2 -> 1
    expect(limiter.check("user").allowed).toBe(true); // 1 -> 0
    expect(limiter.check("user").allowed).toBe(false);

    advance(1000); // one token accrues at 1/sec

    expect(limiter.check("user")).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  });

  it("caps refill at capacity no matter how long the bucket idles", () => {
    const limiter = new RateLimiter({ store, capacity: 2, refillPerSecond: 1, clock });

    expect(limiter.check("user").allowed).toBe(true); // 2 -> 1

    advance(60_000); // would accrue 60 tokens, but capacity is 2

    const result = limiter.check("user"); // refills to 2, spends 1

    expect(result).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
  });

  it("honors a cost greater than one", () => {
    const limiter = new RateLimiter({ store, capacity: 10, refillPerSecond: 1, clock });

    const allowed = limiter.check("user", 4);

    expect(allowed).toEqual({ allowed: true, remaining: 6, retryAfterMs: 0 });

    const denied = limiter.check("user", 10);

    // Deficit of 4 tokens at 1 token/sec => 4000ms.
    expect(denied).toEqual({ allowed: false, remaining: 6, retryAfterMs: 4000 });
  });

  it("floors fractional remaining and tokens", () => {
    const limiter = new RateLimiter({ store, capacity: 5, refillPerSecond: 1, clock });

    expect(limiter.check("user", 5).allowed).toBe(true); // 5 -> 0

    advance(1500); // 1.5 tokens accrue

    const denied = limiter.check("user", 2); // 1.5 < 2: deny, floor(1.5) = 1

    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(1);
  });

  it("defaults to the system clock when none is injected", () => {
    const limiter = new RateLimiter({ store, capacity: 1, refillPerSecond: 1 });

    const before = systemClock();
    const result = limiter.check("user");
    const after = systemClock();

    expect(result.allowed).toBe(true);

    const persisted = store.get("user");

    expect(persisted).toBeDefined();
    expect(persisted?.updatedAt).toBeGreaterThanOrEqual(before);
    expect(persisted?.updatedAt).toBeLessThanOrEqual(after);
  });
});
