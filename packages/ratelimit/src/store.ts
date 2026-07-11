import type { BucketState, RateLimitStore } from "./types";

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
 * ## Bounding the Map (self-eviction)
 *
 * A token bucket keyed by an *attacker-chosen* string — `login:<email>` is the
 * canonical case — turns an unbounded Map into a memory-exhaustion hazard: an
 * unauthenticated flood of distinct keys would grow it without bound (a DoS), and
 * even benign traffic would leak one permanent entry per distinct key forever
 * (worst on a long-lived process, the exact deployment where this store is the
 * "real" default). So, given a `capacity`, we evict a bucket the moment it has
 * *fully refilled* rather than persist it.
 *
 * The eviction is **lossless** — that is the whole trick. A first-seen key and a
 * fully-refilled key are indistinguishable: the limiter starts a missing key at
 * `capacity` (a full bucket), so deleting a full bucket and re-materializing it
 * full on the next check yields the identical verdict. A bucket that is only
 * *partially* drained — an account actively being throttled — is never full, so it
 * is never evicted, and its throttle state is preserved exactly where it matters.
 *
 * This is deliberately NOT an LRU / size-cap eviction. Dropping the *oldest* (or
 * any live) bucket under memory pressure would let an attacker flood distinct keys
 * to push a *targeted* account's still-draining bucket out of the Map, resetting
 * its count — a limiter bypass. Evicting only on full refill can never do that: the
 * only buckets it ever drops carry no throttle state to lose.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState>();

  /**
   * The bucket ceiling, when the caller wires one. A bucket that refills to this
   * many tokens is full == a first-seen key, so it is evicted rather than retained
   * (see the class doc). Left `undefined`, the store never self-evicts — the
   * original always-persist behavior, kept so an existing caller is not broken.
   */
  private readonly capacity: number | undefined;

  constructor(options: { readonly capacity?: number } = {}) {
    this.capacity = options.capacity;
  }

  /**
   * How many buckets are held right now — the Map's live size. Read-only, and the
   * observable proof that self-eviction keeps this bounded by the count of
   * *actively-throttled* keys, not the count of keys ever seen.
   */
  get size(): number {
    return this.buckets.size;
  }

  async update(
    key: string,
    mutate: (current: BucketState | undefined) => BucketState,
  ): Promise<BucketState> {
    const next = mutate(this.buckets.get(key));

    // Evict a fully-refilled bucket instead of persisting it. A full bucket is
    // byte-identical to the state a first-seen key would materialize, so dropping
    // it loses no throttle information (see the class doc) and keeps the Map from
    // accreting one permanent entry per attacker-chosen key. `>=` because
    // continuous refill can overshoot the ceiling by a hair before the limiter's
    // own `Math.min(capacity, …)` clamps it. With no capacity wired we always
    // persist — the pre-eviction semantics, unchanged.
    if (this.capacity !== undefined && next.tokens >= this.capacity) {
      this.buckets.delete(key);
    } else {
      this.buckets.set(key, next);
    }

    return next;
  }
}
