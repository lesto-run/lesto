import { beforeEach, describe, expect, it } from "vitest";

import { MemoryRateLimitStore, RateLimitError, RateLimiter, systemClock } from "../src/index";

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

// ---------------------------------------------------------------------------
// MemoryRateLimitStore self-eviction (bounded Map) — L-8244c703
//
// The store is keyed by attacker-chosen strings (`login:<email>`), so persisting
// every key forever is a memory-exhaustion DoS + a per-key leak. Given a capacity
// the store evicts a bucket the moment it fully refills, because a full bucket ==
// a first-seen key and so carries no throttle state to lose. The invariant these
// tests defend: eviction is lossless (an evicted key re-materializes identically)
// AND a partially-drained, actively-throttled bucket is NEVER evicted — the two
// halves that make this a bound rather than a limiter bypass.
// ---------------------------------------------------------------------------

describe("MemoryRateLimitStore self-eviction (bounded Map)", () => {
  it("does not leak an entry for a cost-0 peek on a first-seen key", async () => {
    const capped = new MemoryRateLimitStore({ capacity: 5 });
    const limiter = new RateLimiter({ store: capped, capacity: 5, refillPerSecond: 1, clock });

    // A cost-0 peek (the shape `login()` uses before it decides to throttle)
    // spends nothing, so the bucket is still full → evicted. The attacker-chosen
    // key leaves NO permanent entry — the leak/DoS the fix closes.
    const peek = await limiter.check("login:ghost@example.com", 0);

    expect(peek).toEqual({ allowed: true, remaining: 5, retryAfterMs: 0 });
    expect(capped.size).toBe(0);
  });

  it("evicts a bucket once it has fully refilled (the Map shrinks back to 0)", async () => {
    const capped = new MemoryRateLimitStore({ capacity: 5 });
    const limiter = new RateLimiter({ store: capped, capacity: 5, refillPerSecond: 1, clock });

    // Spend one token so the bucket is partially drained and must be persisted.
    await limiter.check("login:ada@example.com"); // 5 -> 4
    expect(capped.size).toBe(1);

    // Idle long enough to refill to the ceiling (4 -> 5 at 1/sec).
    advance(1000);
    await limiter.check("login:ada@example.com", 0); // refills to 5, spends 0

    // Fully refilled == first-seen, so the entry is dropped: no residue.
    expect(capped.size).toBe(0);

    // And it re-materializes identically — eviction lost no state.
    const fresh = await limiter.check("login:ada@example.com", 0);
    expect(fresh).toEqual({ allowed: true, remaining: 5, retryAfterMs: 0 });
  });

  it("never evicts a partially-drained (throttled) bucket — no bypass under a flood", async () => {
    const capped = new MemoryRateLimitStore({ capacity: 3 });
    const limiter = new RateLimiter({ store: capped, capacity: 3, refillPerSecond: 1, clock });

    // Drain the target's bucket to empty — it is now actively throttled, below
    // capacity, so it MUST persist (evicting it would reset an in-progress cap).
    expect((await limiter.check("login:target")).allowed).toBe(true); // 3 -> 2
    expect((await limiter.check("login:target")).allowed).toBe(true); // 2 -> 1
    expect((await limiter.check("login:target")).allowed).toBe(true); // 1 -> 0
    expect((await limiter.check("login:target")).allowed).toBe(false); // drained
    expect(capped.size).toBe(1);

    // Flood 100 distinct first-seen keys — each is a full bucket that self-evicts
    // on write, so the Map never accretes them AND (unlike an LRU/size cap) the
    // flood cannot push the throttled target out. Only the target remains: that is
    // the bypass this eviction rule is specifically shaped to forbid.
    for (let i = 0; i < 100; i++) {
      await limiter.check(`login:flood-${i}`, 0);
    }

    expect(capped.size).toBe(1);

    // The target is STILL throttled — the flood bought the attacker nothing.
    expect((await limiter.check("login:target")).allowed).toBe(false);
  });

  it("with NO capacity, always persists — the backward-compatible default", async () => {
    const uncapped = new MemoryRateLimitStore(); // no capacity wired
    const limiter = new RateLimiter({ store: uncapped, capacity: 5, refillPerSecond: 1, clock });

    // Even a full, untouched bucket (a cost-0 peek on a first-seen key) is
    // retained, exactly as before the eviction option existed — a caller relying
    // on the old always-persist semantics is not broken.
    await limiter.check("login:ada", 0);
    expect(uncapped.size).toBe(1);

    // Still retained after a full refill, too (the branch that would evict when a
    // capacity IS set).
    advance(10_000);
    await limiter.check("login:ada", 0);
    expect(uncapped.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RateLimiter owns the store↔limiter capacity pairing — L-e2d3493b
//
// Self-eviction fires at the STORE's capacity, and the limiter spends against
// ITS capacity: the two are one number that must agree. A drift breaks eviction
// SILENTLY (store cap > limiter cap → the Map leak returns; store cap < limiter
// cap → an actively-throttled bucket reads "full" and is evicted → limiter
// bypass). These tests defend the guard that makes that drift LOUD, not silent.
// ---------------------------------------------------------------------------

describe("RateLimiter store-capacity ownership", () => {
  it("refuses an injected MemoryRateLimitStore whose capacity differs from the limiter's", () => {
    // A store ceiling below the limiter's is the dangerous drift — a throttled
    // bucket in [storeCap, limiterCap) would read "full" and be evicted (a
    // bypass). The limiter must refuse LOUD at construction, not degrade silently.
    const construct = (): RateLimiter =>
      new RateLimiter({
        store: new MemoryRateLimitStore({ capacity: 3 }),
        capacity: 5,
        refillPerSecond: 1,
        clock,
      });

    expect(construct).toThrow(RateLimitError);

    let thrown: unknown;
    try {
      construct();
    } catch (error) {
      thrown = error;
    }

    // Branch on the stable code, never the prose.
    expect((thrown as RateLimitError).code).toBe("RATELIMIT_STORE_CAPACITY_MISMATCH");
    // The mismatched numbers ride the details so an operator sees both ceilings.
    expect((thrown as RateLimitError).details).toMatchObject({
      storeCapacity: 3,
      limiterCapacity: 5,
    });
  });

  it("also refuses a store ceiling ABOVE the limiter's (the never-evicts / leak drift)", () => {
    expect(
      () =>
        new RateLimiter({
          store: new MemoryRateLimitStore({ capacity: 9 }),
          capacity: 5,
          refillPerSecond: 1,
          clock,
        }),
    ).toThrow(RateLimitError);
  });

  it("accepts an injected MemoryRateLimitStore whose capacity matches", async () => {
    const capped = new MemoryRateLimitStore({ capacity: 5 });
    const limiter = new RateLimiter({ store: capped, capacity: 5, refillPerSecond: 1, clock });

    // A matched pair works AND still evicts a fully-refilled bucket (the paired
    // behavior the invariant protects).
    await limiter.check("login:ada", 0);
    expect(capped.size).toBe(0);
  });

  it("accepts an injected uncapped MemoryRateLimitStore — no capacity to drift", () => {
    expect(
      () =>
        new RateLimiter({
          store: new MemoryRateLimitStore(),
          capacity: 5,
          refillPerSecond: 1,
          clock,
        }),
    ).not.toThrow();
  });

  it("accepts a non-MemoryRateLimitStore store (a SQL/Redis store has no capacity to enforce)", () => {
    // Only a MemoryRateLimitStore carries the eviction ceiling the guard pairs
    // against; a bare RateLimitStore implementation is left untouched.
    const custom: RateLimitStore = {
      update: async (_key, mutate) => mutate(undefined),
    };

    expect(
      () => new RateLimiter({ store: custom, capacity: 5, refillPerSecond: 1, clock }),
    ).not.toThrow();
  });

  it("defaults to a capacity-matched MemoryRateLimitStore when none is injected", async () => {
    // No `store`: the limiter builds its own at its OWN capacity (drift-proof by
    // construction — the internal store is not observable, but its ceiling can
    // only be the limiter's). Prove the default-store path works end-to-end:
    // spend the bucket down and confirm the throttle engages at capacity 2.
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, clock });

    expect((await limiter.check("login:ada")).allowed).toBe(true); // 2 -> 1
    expect((await limiter.check("login:ada")).allowed).toBe(true); // 1 -> 0

    const denied = await limiter.check("login:ada"); // drained
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1000); // deficit of 1 token at 1/sec

    // A distinct first-seen key is independently full — proof the default store
    // is a real per-key bucket store, not a shared/degenerate one.
    expect((await limiter.check("login:ghost", 0)).remaining).toBe(2);
  });
});
