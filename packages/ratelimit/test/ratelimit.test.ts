import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MemoryRateLimitStore,
  RATELIMIT_STORE_SATURATED_CODE,
  RateLimitError,
  RateLimiter,
  systemClock,
} from "../src/index";
import { RATELIMIT_DEAD_ONSATURATED_CODE } from "../src/limiter";

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

// ---------------------------------------------------------------------------
// MemoryRateLimitStore hard cap (maxBuckets) — L-976b4302
//
// Eviction-on-refill bounds the BENIGN/idle case, but not an adversarial one: a
// cost-1 request (a failed login, every per-IP request) drains its bucket BELOW
// full, so a flood of distinct keys accretes below-ceiling buckets that
// eviction-on-refill will not drop until they slowly refill — long enough to
// exhaust memory. The hard `maxBuckets` cap closes that: over budget, the store
// evicts the bucket CLOSEST TO FULL (least-throttled → safest), so a targeted,
// heavily-throttled bucket is the LAST evicted and a flood cannot push it out.
// These tests defend the bound AND that closest-to-full invariant — for both the
// refill-aware store and the refill-unaware fallback.
// ---------------------------------------------------------------------------

describe("MemoryRateLimitStore hard cap (maxBuckets)", () => {
  it("rejects a non-positive-integer maxBuckets at construction", () => {
    // A NaN/Infinity/zero/fractional cap has no well-defined eviction and would
    // silently unbound the store — fail LOUD at construction instead.
    expect(() => new MemoryRateLimitStore({ maxBuckets: 0 })).toThrow();
    expect(() => new MemoryRateLimitStore({ maxBuckets: -1 })).toThrow();
    expect(() => new MemoryRateLimitStore({ maxBuckets: 1.5 })).toThrow();
    expect(() => new MemoryRateLimitStore({ maxBuckets: Number.NaN })).toThrow();
    expect(() => new MemoryRateLimitStore({ maxBuckets: Number.POSITIVE_INFINITY })).toThrow();

    // A positive integer is accepted.
    expect(() => new MemoryRateLimitStore({ maxBuckets: 1 })).not.toThrow();
  });

  it("bounds the Map under a below-ceiling flood eviction-on-refill cannot reach", async () => {
    // Each key is hit ONCE at cost 1: first-seen (full 5) → spend 1 → stored at 4,
    // BELOW the ceiling, so eviction-on-refill never fires. Without the hard cap the
    // Map would grow to 100; with it, it never exceeds maxBuckets.
    const bounded = new MemoryRateLimitStore({
      capacity: 5,
      refillPerSecond: 1,
      maxBuckets: 4,
      clock,
    });
    const limiter = new RateLimiter({ store: bounded, capacity: 5, refillPerSecond: 1, clock });

    for (let i = 0; i < 100; i++) {
      expect((await limiter.check(`ip:${i}`)).allowed).toBe(true); // 5 -> 4, never full
    }

    expect(bounded.size).toBe(4);
  });

  it("evicts closest-to-full first, so a flood cannot push out a throttled bucket", async () => {
    const bounded = new MemoryRateLimitStore({
      capacity: 5,
      refillPerSecond: 1,
      maxBuckets: 3,
      clock,
    });
    const limiter = new RateLimiter({ store: bounded, capacity: 5, refillPerSecond: 1, clock });

    // Drain the victim to empty — actively throttled, the farthest thing from full.
    for (let i = 0; i < 5; i++) await limiter.check("login:victim"); // 5 -> 0
    expect((await limiter.check("login:victim")).allowed).toBe(false); // throttled

    // Flood distinct keys, each stored near-full (4). The clock is frozen, so nothing
    // refills: every overflow must evict, and closest-to-full always picks a flood
    // bucket (4) over the victim (0). The victim is never the eviction target.
    for (let i = 0; i < 100; i++) {
      await limiter.check(`login:flood-${i}`); // 5 -> 4
    }

    expect(bounded.size).toBe(3); // bounded

    // The victim survived AND is still throttled — the flood bought nothing. Were it
    // evicted, it would re-materialize full and this check would ALLOW.
    expect((await limiter.check("login:victim")).allowed).toBe(false);
  });

  it("lazily sweeps buckets that refilled to full while idle, in bulk, on overflow", async () => {
    const bounded = new MemoryRateLimitStore({
      capacity: 5,
      refillPerSecond: 1,
      maxBuckets: 3,
      clock,
    });
    const limiter = new RateLimiter({ store: bounded, capacity: 5, refillPerSecond: 1, clock });

    // Three keys each drained to 4 and then left idle — persisted, below the ceiling,
    // so eviction-on-refill never fired for them.
    await limiter.check("a"); // 5 -> 4
    await limiter.check("b");
    await limiter.check("c");
    expect(bounded.size).toBe(3);

    // Idle a full second: a, b, c all refill to the ceiling (4 -> 5), but nothing
    // RE-checks them, so they linger — the exact leak the sweep exists to reclaim.
    advance(1000);

    // A 4th key tips the store over budget. The overflow sweep computes each bucket's
    // fullness AS OF NOW: a, b, c read 5 (full) and are dropped losslessly, leaving
    // only the freshly-written d. Reclaimed in one pass, not one-at-a-time.
    await limiter.check("d"); // 5 -> 4
    expect(bounded.size).toBe(1);
  });

  it("bounds and protects the throttled bucket even with NO refill rate (the coarse fallback)", async () => {
    // capacity but no refillPerSecond → the store cannot age buckets, so it ranks by
    // stored tokens instead. Still a hard bound, and still monotone: a drained bucket
    // stores fewer tokens than a fresh one, so the throttled victim is protected.
    const bounded = new MemoryRateLimitStore({ capacity: 5, maxBuckets: 3 });
    const limiter = new RateLimiter({ store: bounded, capacity: 5, refillPerSecond: 1, clock });

    for (let i = 0; i < 5; i++) await limiter.check("login:victim"); // 5 -> 0
    expect((await limiter.check("login:victim")).allowed).toBe(false);

    for (let i = 0; i < 50; i++) {
      await limiter.check(`login:flood-${i}`); // 5 -> 4
    }

    expect(bounded.size).toBe(3); // bounded by stored-token rank
    expect((await limiter.check("login:victim")).allowed).toBe(false); // victim protected
  });

  it("breaks a closest-to-full tie toward the LATER-inserted key, protecting the earlier target", async () => {
    // Two buckets end up equally full; the eviction must drop the one inserted
    // LATER (a flood newcomer), never the earlier one (a target throttled first).
    const bounded = new MemoryRateLimitStore({
      capacity: 5,
      refillPerSecond: 1,
      maxBuckets: 2,
      clock,
    });
    const limiter = new RateLimiter({ store: bounded, capacity: 5, refillPerSecond: 1, clock });

    // Insertion order a, b, c with the clock frozen (no refill), so fullness ==
    // stored tokens throughout: a=4 (full-ish, earliest), b=2 (the *least* full,
    // in the middle → exercises the victim scan's "not a new max" path), then c=4
    // ties a. `maxBuckets: 2` makes c's insert overflow.
    await limiter.check("a", 1); // 5 -> 4
    await limiter.check("b", 3); // 5 -> 2
    expect(bounded.size).toBe(2);

    await limiter.check("c", 1); // 5 -> 4; now over cap → evict

    // c (4) ties a (4) for closest-to-full; `>=` drops the LATER insertion, c. With
    // a strict `>` tie-break this would evict a (the earlier key) instead — so this
    // assertion goes RED under the unsafe FIFO tie-break.
    expect(bounded.size).toBe(2);
    // a survives full-ish, b survives throttled, c (the newcomer) is gone.
    expect((await limiter.check("a", 0)).remaining).toBe(4);
    expect((await limiter.check("b", 0)).remaining).toBe(2);
    // c was evicted, so it re-materializes as a fresh, full bucket.
    expect((await limiter.check("c", 0)).remaining).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// MemoryRateLimitStore saturation signal — L-b5bae0a4
//
// The hard cap shedding a throttled bucket is an ATTACK signal (a distinct-key
// flood, or a cap too low for real traffic). A silent bound would hide exactly
// what it defends against (ADR 0011 loud-when-wrong). So: warn ONCE on the first
// live eviction (default console.warn w/ a stable code, injectable), count EVERY
// one, and stay silent for the lossless full-refill sweep (housekeeping).
// ---------------------------------------------------------------------------

describe("MemoryRateLimitStore saturation signal", () => {
  it("fires onSaturated ONCE and counts every throttled-bucket eviction; maxBuckets is public", async () => {
    let calls = 0;
    const bounded = new MemoryRateLimitStore({
      capacity: 5,
      refillPerSecond: 1,
      maxBuckets: 3,
      clock,
      onSaturated: () => {
        calls += 1;
      },
    });
    const limiter = new RateLimiter({ store: bounded, capacity: 5, refillPerSecond: 1, clock });

    // Frozen clock: nothing refills, so the sweep reclaims nothing and every insert
    // past the cap is a LIVE (throttled-bucket) eviction — the attack signal.
    for (let i = 0; i < 10; i++) await limiter.check(`ip:${i}`); // each 5 -> 4, below ceiling

    expect(bounded.size).toBe(3); // bounded
    expect(bounded.maxBuckets).toBe(3); // publicly readable for saturation math
    expect(bounded.saturationEvictions).toBe(7); // 10 inserts, first 3 fit → 7 evictions
    expect(calls).toBe(1); // warned ONCE across 7 evictions — not a log flood
  });

  it("stays SILENT for the lossless full-refill sweep — housekeeping is not an attack", async () => {
    let calls = 0;
    const bounded = new MemoryRateLimitStore({
      capacity: 5,
      refillPerSecond: 1,
      maxBuckets: 3,
      clock,
      onSaturated: () => {
        calls += 1;
      },
    });
    const limiter = new RateLimiter({ store: bounded, capacity: 5, refillPerSecond: 1, clock });

    await limiter.check("a"); // 5 -> 4
    await limiter.check("b");
    await limiter.check("c");
    advance(1000); // a, b, c refill 4 -> 5 (full) while idle
    await limiter.check("d"); // overflow → sweep reclaims a, b, c (all full): NO live eviction

    expect(bounded.size).toBe(1);
    expect(bounded.saturationEvictions).toBe(0); // the sweep does not count
    expect(calls).toBe(0); // and does not warn
  });

  it("warns once by DEFAULT (no hook injected), carrying the stable code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const bounded = new MemoryRateLimitStore({
        capacity: 5,
        refillPerSecond: 1,
        maxBuckets: 2,
        clock,
      });
      const limiter = new RateLimiter({ store: bounded, capacity: 5, refillPerSecond: 1, clock });

      for (let i = 0; i < 5; i++) await limiter.check(`ip:${i}`); // 3 evictions

      expect(warn).toHaveBeenCalledTimes(1); // default warn, once
      expect(String(warn.mock.calls[0]?.[0])).toContain(RATELIMIT_STORE_SATURATED_CODE);
    } finally {
      warn.mockRestore();
    }
  });

  it("routes RateLimiterOptions.onSaturated into the store the limiter builds (end-to-end)", async () => {
    // No injected store → the limiter auto-builds one at the DEFAULT 10k cap and
    // threads onSaturated in. Overflow the 10k to prove the signal actually fires
    // through the limiter seam (the per-IP/identity default path), not just compiles.
    let calls = 0;
    const limiter = new RateLimiter({
      capacity: 5,
      refillPerSecond: 1,
      clock,
      onSaturated: () => {
        calls += 1;
      },
    });

    for (let i = 0; i <= 10_000; i++) await limiter.check(`ip:${i}`); // 10_001 distinct keys

    expect(calls).toBe(1); // the auto-built store's cap engaged and surfaced through the limiter
    // …and the continuous counter is reachable THROUGH the limiter (no store handle),
    // so a caller on the auto-built path can still poll saturation — 1 eviction so far.
    expect(limiter.saturationEvictions).toBe(1);
  });

  it("reports saturationEvictions as undefined when the store is not an in-memory one", async () => {
    // A SQL/Redis-shaped custom store has no in-memory cap to saturate, so the
    // accessor is undefined rather than a misleading 0.
    const custom: RateLimitStore = { update: async (_key, mutate) => mutate(undefined) };
    const limiter = new RateLimiter({ store: custom, capacity: 5, refillPerSecond: 1, clock });

    await limiter.check("user");

    expect(limiter.saturationEvictions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RateLimiter store↔limiter refill-rate pairing — L-976b4302
//
// The store ages idle buckets at ITS refillPerSecond and the limiter refills at
// ITS own: a drift lets the store think a still-throttled bucket has refilled to
// full and evict it (a bypass), or never age buckets it should. Same silent-drift
// hazard as the capacity pairing (L-e2d3493b) — guarded the same LOUD way.
// ---------------------------------------------------------------------------

describe("RateLimiter store-refill pairing", () => {
  it("refuses an injected MemoryRateLimitStore whose refillPerSecond differs from the limiter's", () => {
    const construct = (): RateLimiter =>
      new RateLimiter({
        store: new MemoryRateLimitStore({ capacity: 5, refillPerSecond: 2 }),
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

    expect((thrown as RateLimitError).code).toBe("RATELIMIT_STORE_REFILL_MISMATCH");
    expect((thrown as RateLimitError).details).toMatchObject({
      storeRefillPerSecond: 2,
      limiterRefillPerSecond: 1,
    });
  });

  it("accepts an injected store whose capacity AND refillPerSecond both match", () => {
    expect(
      () =>
        new RateLimiter({
          store: new MemoryRateLimitStore({ capacity: 5, refillPerSecond: 1, clock }),
          capacity: 5,
          refillPerSecond: 1,
          clock,
        }),
    ).not.toThrow();
  });

  it("leaves a store with a capacity but no refillPerSecond alone — nothing to drift", () => {
    expect(
      () =>
        new RateLimiter({
          store: new MemoryRateLimitStore({ capacity: 5 }),
          capacity: 5,
          refillPerSecond: 1,
          clock,
        }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// MemoryRateLimitStore clock contract (enforced) — L-2dc55e6c
//
// The overflow sweep ages every OTHER bucket to decide which have refilled. It
// used to age them against the just-written `next.updatedAt`, trusting it as the
// reference "now" — so a single write with a FUTURE timestamp (attacker-derived,
// or a second limiter under a faster clock) read every throttled bucket as fully
// refilled and mass-evicted live throttle state. The fix ages against the store's
// OWN injected clock (never the written timestamp) AND — for a refill-aware store
// shared by a second limiter under a different clock — refuses the mismatch LOUD.
// ---------------------------------------------------------------------------

describe("MemoryRateLimitStore clock contract (enforced)", () => {
  it("ages the overflow sweep against its own clock, not a written future updatedAt", async () => {
    // Three throttled buckets (tokens 0), then a 4th write whose updatedAt is far in
    // the FUTURE — the direct-caller / attacker-derived case. The store's frozen clock
    // is the reference now, so the victims age against ~0 elapsed and survive; only the
    // over-cap newcomer is shed. Under the old code the future stamp aged all three to
    // full and mass-evicted them (size would collapse to 1), so these assertions go RED.
    const bounded = new MemoryRateLimitStore({
      capacity: 5,
      refillPerSecond: 1,
      maxBuckets: 3,
      clock, // the module clock, frozen at `now`
    });

    await bounded.update("v1", () => ({ tokens: 0, updatedAt: now }));
    await bounded.update("v2", () => ({ tokens: 0, updatedAt: now }));
    await bounded.update("v3", () => ({ tokens: 0, updatedAt: now }));
    expect(bounded.size).toBe(3);

    // A 4th write, far in the future, tips the store one over the cap.
    await bounded.update("attacker", () => ({ tokens: 0, updatedAt: now + 1_000_000_000 }));

    // Still bounded, and all three throttled victims are intact (old code: size 1).
    expect(bounded.size).toBe(3);

    for (const key of ["v1", "v2", "v3"]) {
      let seen: BucketState | undefined;
      await bounded.update(key, (current) => {
        seen = current;
        return current ?? { tokens: 0, updatedAt: now };
      });
      expect(seen).toEqual({ tokens: 0, updatedAt: now });
    }
  });

  it("refuses a refill-aware store shared under a SECOND, different clock", () => {
    // The module-level `clock` (captures `now`) binds the store and the first limiter.
    const shared = new MemoryRateLimitStore({ capacity: 5, refillPerSecond: 1, clock });

    // First limiter uses the SAME clock as the store — they match, so this is fine.
    expect(
      () => new RateLimiter({ store: shared, capacity: 5, refillPerSecond: 1, clock }),
    ).not.toThrow();

    // A second limiter under a DIFFERENT clock function would let the overflow sweep
    // age this store's buckets against the wrong `now` and mass-evict — refused LOUD.
    const otherClock = (): number => now;
    const construct = (): RateLimiter =>
      new RateLimiter({ store: shared, capacity: 5, refillPerSecond: 1, clock: otherClock });

    expect(construct).toThrow(RateLimitError);

    let thrown: unknown;
    try {
      construct();
    } catch (error) {
      thrown = error;
    }

    expect((thrown as RateLimitError).code).toBe("RATELIMIT_STORE_CLOCK_MISMATCH");
  });

  it("accepts a refill-aware store on the shared systemClock default (all-default match)", () => {
    // Neither store nor limiter overrides the clock: both default to the SAME
    // systemClock singleton, so the guard matches by reference and never trips —
    // the common injected-store path stays ergonomic.
    expect(
      () =>
        new RateLimiter({
          store: new MemoryRateLimitStore({ capacity: 5, refillPerSecond: 1 }),
          capacity: 5,
          refillPerSecond: 1,
        }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// RateLimiter dead onSaturated (injected store) — L-ebb33e60
//
// onSaturated is routed ONLY into the store the limiter builds itself (the `??`
// below short-circuits the auto-build when a store is injected), so passing BOTH
// an injected store AND onSaturated is dead config — the hook silently never fires.
// The adjacent capacity/refill drift THROWS a coded error; this is a lower-severity
// observability footgun (the injected store still carries its OWN saturation signal),
// so it warns LOUDLY with a stable code rather than crashing construction — but it is
// no longer SILENT, which is the inconsistency this closes.
// ---------------------------------------------------------------------------

describe("RateLimiter dead onSaturated (injected store)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns with the coded signal when onSaturated is passed alongside an injected store", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onSaturated = vi.fn();

    const limiter = new RateLimiter({
      store: new MemoryRateLimitStore({ capacity: 5, refillPerSecond: 1, clock }),
      capacity: 5,
      refillPerSecond: 1,
      clock,
      onSaturated,
    });
    expect(limiter).toBeDefined();

    // Loud, not silent: exactly one warn at construction, carrying the stable code
    // (logs branch on the code, never the prose).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(RATELIMIT_DEAD_ONSATURATED_CODE);

    // And the dead hook is NOT smuggled into the injected store — warning is the whole
    // remedy; the limiter never wires a limiter-level onSaturated into an injected store.
    expect(onSaturated).not.toHaveBeenCalled();
  });

  it("does NOT warn when onSaturated is passed with NO store injected (the live auto-build path)", () => {
    // The path that DOES route onSaturated (into the store the limiter builds). Nothing
    // is dead here, so the dead-config warn must stay silent — pins that the guard keys
    // on an injected store, not merely on onSaturated being set.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const limiter = new RateLimiter({
      capacity: 5,
      refillPerSecond: 1,
      clock,
      onSaturated: () => undefined,
    });
    expect(limiter).toBeDefined();

    expect(warn).not.toHaveBeenCalled();
  });
});
