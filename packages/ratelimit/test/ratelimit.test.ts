import { beforeEach, describe, expect, it } from "vitest";

import { MemoryRateLimitStore, RateLimiter, systemClock } from "../src/index";

import type { BucketState, RateLimitStore } from "../src/index";

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
  it("update atomically reads, mutates, persists, and returns the next state", async () => {
    // First-seen key: mutate receives undefined.
    let seen: BucketState | undefined = { tokens: -1, updatedAt: -1 };
    const next = await store.update("k", (current) => {
      seen = current;
      return { tokens: 3, updatedAt: now };
    });

    expect(seen).toBeUndefined();
    expect(next).toEqual({ tokens: 3, updatedAt: now });

    // A second update sees the persisted state.
    const after = await store.update("k", (current) => {
      expect(current).toEqual({ tokens: 3, updatedAt: now });
      return { tokens: 2, updatedAt: now };
    });

    expect(after).toEqual({ tokens: 2, updatedAt: now });
  });
});

describe("RateLimiter.check", () => {
  it("allows the first check from a full bucket", async () => {
    const limiter = new RateLimiter({ store, capacity: 5, refillPerSecond: 1, clock });

    const result = await limiter.check("user");

    expect(result).toEqual({ allowed: true, remaining: 4, retryAfterMs: 0 });
  });

  it("exhausts the bucket, then denies with a positive retryAfterMs", async () => {
    const limiter = new RateLimiter({ store, capacity: 3, refillPerSecond: 2, clock });

    expect((await limiter.check("user")).allowed).toBe(true); // 3 -> 2
    expect((await limiter.check("user")).allowed).toBe(true); // 2 -> 1
    expect((await limiter.check("user")).allowed).toBe(true); // 1 -> 0

    const denied = await limiter.check("user");

    // Deficit of 1 token at 2 tokens/sec => 500ms to accrue.
    expect(denied).toEqual({ allowed: false, remaining: 0, retryAfterMs: 500 });
  });

  it("leaves remaining unchanged when it denies", async () => {
    const limiter = new RateLimiter({ store, capacity: 1, refillPerSecond: 1, clock });

    expect((await limiter.check("user")).allowed).toBe(true); // 1 -> 0

    const first = await limiter.check("user");
    const second = await limiter.check("user");

    expect(first.remaining).toBe(0);
    expect(second.remaining).toBe(0);
  });

  it("refills as the clock advances and re-allows", async () => {
    const limiter = new RateLimiter({ store, capacity: 2, refillPerSecond: 1, clock });

    expect((await limiter.check("user")).allowed).toBe(true); // 2 -> 1
    expect((await limiter.check("user")).allowed).toBe(true); // 1 -> 0
    expect((await limiter.check("user")).allowed).toBe(false);

    advance(1000); // one token accrues at 1/sec

    expect(await limiter.check("user")).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  });

  it("caps refill at capacity no matter how long the bucket idles", async () => {
    const limiter = new RateLimiter({ store, capacity: 2, refillPerSecond: 1, clock });

    expect((await limiter.check("user")).allowed).toBe(true); // 2 -> 1

    advance(60_000); // would accrue 60 tokens, but capacity is 2

    const result = await limiter.check("user"); // refills to 2, spends 1

    expect(result).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
  });

  it("honors a cost greater than one", async () => {
    const limiter = new RateLimiter({ store, capacity: 10, refillPerSecond: 1, clock });

    const allowed = await limiter.check("user", 4);

    expect(allowed).toEqual({ allowed: true, remaining: 6, retryAfterMs: 0 });

    const denied = await limiter.check("user", 10);

    // Deficit of 4 tokens at 1 token/sec => 4000ms.
    expect(denied).toEqual({ allowed: false, remaining: 6, retryAfterMs: 4000 });
  });

  it("floors fractional remaining and tokens", async () => {
    const limiter = new RateLimiter({ store, capacity: 5, refillPerSecond: 1, clock });

    expect((await limiter.check("user", 5)).allowed).toBe(true); // 5 -> 0

    advance(1500); // 1.5 tokens accrue

    const denied = await limiter.check("user", 2); // 1.5 < 2: deny, floor(1.5) = 1

    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(1);
  });

  it("is consistent when the store invokes mutate more than once (retry contract)", async () => {
    // A store whose `update` runs `mutate` twice before persisting — the SQL
    // store's first-insert-race retry shape. The limiter must return the verdict
    // for the invocation the store actually kept (the last one).
    const doubleStore: RateLimitStore = {
      update: async (_key, mutate) => {
        mutate(undefined); // discarded first attempt
        return mutate(undefined); // the one that "wins"
      },
    };
    const limiter = new RateLimiter({ store: doubleStore, capacity: 5, refillPerSecond: 1, clock });

    const result = await limiter.check("user");

    expect(result).toEqual({ allowed: true, remaining: 4, retryAfterMs: 0 });
  });

  it("defaults to the system clock when none is injected", async () => {
    const limiter = new RateLimiter({ store, capacity: 1, refillPerSecond: 1 });

    const before = systemClock();
    const result = await limiter.check("user");
    const after = systemClock();

    expect(result.allowed).toBe(true);

    let persisted: BucketState | undefined;
    await store.update("user", (current) => {
      persisted = current;
      return current!;
    });

    expect(persisted).toBeDefined();
    expect(persisted?.updatedAt).toBeGreaterThanOrEqual(before);
    expect(persisted?.updatedAt).toBeLessThanOrEqual(after);
  });
});
