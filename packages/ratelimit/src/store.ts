import { refilledTokens } from "./refill";

import type { BucketState, RateLimitStore } from "./types";

/**
 * The default hard ceiling on how many buckets the store retains at once.
 *
 * Matches the order of magnitude the other unbounded-by-default surfaces in this
 * monorepo settled on (`DEFAULT_MAX_ENTRIES` in `@lesto/cache`): generous enough
 * that no ordinary app-scale limiter ever reaches it, small enough that a flood
 * of attacker-chosen keys cannot grow the Map until the process runs out of
 * memory. It is a HARD bound — reached, the store evicts to stay under it — not a
 * hint.
 */
const DEFAULT_MAX_BUCKETS = 10_000;

/**
 * The simplest store that works: an in-process Map.
 *
 * State lives only in memory, so it is per-process and resets on restart — fine
 * for a single node or for tests. Swap in a SQL- or Redis-backed store (same
 * interface) when limits must hold across a fleet.
 *
 * `update` is atomic by construction: single-threaded JS plus a synchronous
 * `mutate` means nothing can interleave between the read and the write.
 *
 * ## Bounding the Map
 *
 * A token bucket keyed by an *attacker-chosen* string — `login:<email>` or a
 * per-client IP is the canonical case — turns an unbounded Map into a
 * memory-exhaustion hazard: an unauthenticated flood of distinct keys would grow
 * it without bound (a DoS), and even benign traffic would leak one permanent
 * entry per distinct key forever. Two complementary mechanisms keep it bounded:
 *
 * **1. Evict-on-refill (lossless, the cheap common case).** Given a `capacity`, a
 * bucket that sits *at* the ceiling is evicted rather than persisted. A first-seen
 * key and a fully-refilled key are indistinguishable — the limiter starts a
 * missing key at `capacity` (a full bucket) — so deleting a full bucket and
 * re-materializing it full on the next check yields the identical verdict. This
 * fires the instant a full bucket is *written* (a cost-0 peek, a fully-idled key
 * re-checked); given a `refillPerSecond` it *also* fires as a lazy sweep the
 * moment the store is over budget, reclaiming buckets that refilled to full while
 * idle and so were never re-checked. A partially-drained, actively-throttled
 * bucket is never full, so it is never touched by this mechanism.
 *
 * **2. A hard cap (`maxBuckets`), for the adversarial case eviction-on-refill
 * cannot reach.** A *failed* login (or any cost-1 request) drains its bucket
 * *below* full, so under a flood of distinct keys the Map fills with
 * below-ceiling buckets that eviction-on-refill will not drop until they refill —
 * which, for a slow limiter, is far longer than the flood takes to exhaust
 * memory. So once the Map exceeds `maxBuckets` the store evicts the bucket
 * **closest to full** — the least-throttled, hence the safest to drop: dropping it
 * costs its owner at most the sliver of throttle it had left, while the *most*
 * throttled bucket (a targeted account under a brute-force flood) is the
 * *farthest* from full and so the LAST thing evicted.
 *
 * That closest-to-full order is the invariant that makes the cap safe, and it is
 * deliberately **not** an LRU / oldest-first eviction: dropping the least-recently
 * touched bucket would let an attacker flood distinct keys to push a *targeted*
 * account's still-draining (but idle) bucket out of the Map, resetting its count —
 * a limiter bypass. Ranking by fullness can never do that, because a flood's
 * fresh near-full buckets are always fuller than the account being throttled.
 *
 * ## The store↔limiter pairing
 *
 * `capacity` and `refillPerSecond` describe the SAME token bucket the paired
 * {@link RateLimiter} spends against; they MUST equal the limiter's, or eviction
 * misfires silently (a store ceiling above the limiter's never evicts — the leak
 * returns; below it evicts actively-throttled buckets — a bypass). The limiter
 * owns that pairing: it builds this store at its own `capacity`/`refillPerSecond`
 * when none is injected, and refuses an injected one whose values drift (see the
 * RateLimiter ctor). Both fields are `public readonly` for that guard to read.
 * Left unset, the store simply skips the mechanism that needs them: no `capacity`
 * disables eviction-on-refill; no `refillPerSecond` disables the lazy sweep and
 * makes the hard cap rank by stored tokens (a coarser but still-safe proxy — a
 * drained bucket stores fewer tokens than a fresh one). The hard cap itself is
 * always on.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState>();

  /**
   * The bucket ceiling — the most tokens a bucket can hold, and the point at
   * which a written bucket is full and so evicted (see the class doc). `public`
   * so the paired {@link RateLimiter} can enforce it equals its own spend ceiling;
   * exposed for that guard, not as a mutation seam. Left `undefined`, the store
   * never evicts-on-refill (the original always-persist behavior).
   */
  readonly capacity: number | undefined;

  /**
   * How fast a bucket refills, in tokens per second — the SAME rate the paired
   * {@link RateLimiter} refills at (see the class doc; `public` for the same
   * drift guard as {@link capacity}). With it, the store can compute how full any
   * bucket has grown *as of now* and so reclaim idle-refilled buckets and evict
   * the genuinely-closest-to-full under pressure. Left `undefined`, both fall back
   * to ranking by last-stored tokens.
   */
  readonly refillPerSecond: number | undefined;

  /** The hard ceiling on retained buckets — see {@link DEFAULT_MAX_BUCKETS}. */
  private readonly maxBuckets: number;

  constructor(
    options: {
      readonly capacity?: number;
      readonly refillPerSecond?: number;
      readonly maxBuckets?: number;
    } = {},
  ) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;

    const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;

    // A positive integer is the only value with well-defined eviction: `NaN` makes
    // `size > maxBuckets` always false, so the cap never engages and the leak this
    // store exists to prevent returns; `Infinity` likewise never evicts; `<= 0`
    // and fractional caps are misconfigurations. Fail at construction, loudly,
    // rather than silently unbound the store at runtime (mirrors `@lesto/cache`).
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1) {
      throw new Error(
        `MemoryRateLimitStore maxBuckets must be a positive integer, received ${maxBuckets}.`,
      );
    }

    this.maxBuckets = maxBuckets;
  }

  /**
   * How many buckets are held right now — the Map's live size. Read-only, and the
   * observable proof that the store stays bounded: never above {@link maxBuckets},
   * and in ordinary use bounded by the count of *actively-throttled* keys rather
   * than the count of keys ever seen.
   */
  get size(): number {
    return this.buckets.size;
  }

  async update(
    key: string,
    mutate: (current: BucketState | undefined) => BucketState,
  ): Promise<BucketState> {
    const next = mutate(this.buckets.get(key));

    // Evict-on-refill: a bucket written at (or above) the ceiling is byte-identical
    // to the state a first-seen key would materialize, so dropping it loses no
    // throttle information (see the class doc) and keeps the Map from accreting one
    // permanent entry per attacker-chosen key. `>=` because continuous refill can
    // overshoot the ceiling by a hair before the limiter's own `Math.min` clamps
    // it. With no capacity wired we always persist — the pre-eviction semantics. A
    // delete cannot grow the Map, so there is nothing to bound afterward.
    if (this.capacity !== undefined && next.tokens >= this.capacity) {
      this.buckets.delete(key);

      return next;
    }

    this.buckets.set(key, next);

    // Enforce the hard cap. `next.updatedAt` is the limiter's own "now" (it stamps
    // every write with the current clock), so we reuse it as the reference time for
    // aging every *other* bucket — no separate clock to inject, and no way for a
    // store clock to drift from the limiter's.
    if (this.buckets.size > this.maxBuckets) {
      this.evictToBound(next.updatedAt);
    }

    return next;
  }

  /**
   * Bring the Map back to `maxBuckets`, safest-to-drop first.
   *
   * Only runs once the cap is actually exceeded, so a store that never fills past
   * it (the common case) pays nothing beyond the `set` that was already happening.
   * Each `update` inserts at most one new key, so the Map exceeds the cap by at
   * most one: the full-refill sweep may reclaim several at once, and if that alone
   * does not restore the bound a single closest-to-full eviction does. One O(n)
   * pass over a bounded Map, the same cost profile as `@lesto/cache`'s overflow
   * eviction.
   */
  private evictToBound(now: number): void {
    const capacity = this.capacity;
    const refillPerSecond = this.refillPerSecond;
    const refillAware = capacity !== undefined && refillPerSecond !== undefined;

    // Sweep fully-refilled buckets first (refill-aware only). A bucket that has
    // refilled to its ceiling as of `now` is byte-identical to a first-seen key,
    // so dropping it is lossless — eviction-on-refill applied to buckets that
    // refilled while idle and so were never re-checked. Mirrors `@lesto/cache`
    // spending expired entries before it evicts a live one: reclaim the dead
    // before touching the living. It may bring the Map back under the cap on its
    // own, in which case there is nothing left to evict below.
    if (refillAware) {
      for (const [key, state] of this.buckets) {
        if (refilledTokens(state, now, capacity, refillPerSecond) >= capacity) {
          this.buckets.delete(key);
        }
      }
    }

    if (this.buckets.size <= this.maxBuckets) return;

    // Still over the cap by one: every remaining bucket is actively throttled
    // (below its ceiling). Evict the single closest to full — the least-throttled,
    // so a targeted near-empty bucket is the last to go and a flood of distinct
    // keys cannot push it out (see the class doc). A refill-unaware store lacks the
    // clock to age buckets, so it ranks by stored tokens — a coarser but still
    // monotone proxy. The Map is non-empty here (`size > maxBuckets >= 1`), so the
    // first bucket seeds the victim and `chosen` is always resolved to a real key.
    let victimKey = "";
    let victimFullness = 0;
    let chosen = false;

    for (const [key, state] of this.buckets) {
      const fullness = refillAware
        ? refilledTokens(state, now, capacity, refillPerSecond)
        : state.tokens;

      if (!chosen || fullness > victimFullness) {
        chosen = true;
        victimFullness = fullness;
        victimKey = key;
      }
    }

    this.buckets.delete(victimKey);
  }
}
