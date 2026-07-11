import { RateLimitError } from "./errors";
import { refilledTokens } from "./refill";
import { MemoryRateLimitStore } from "./store";
import { systemClock } from "./time";

import type { BucketState, Clock, RateLimitResult, RateLimitStore } from "./types";

export interface RateLimiterOptions {
  /**
   * Where buckets live between checks. OPTIONAL: omit it and the limiter builds
   * its own {@link MemoryRateLimitStore} at *its own* `capacity` and
   * `refillPerSecond`, so the store's eviction math can never drift from the
   * limiter's — the common path is drift-proof by construction. Inject one to
   * share a store across limiters or to back the limiter with SQL/Redis. An
   * injected {@link MemoryRateLimitStore} whose `capacity` or `refillPerSecond`
   * is set MUST equal the values below; the limiter refuses a mismatch LOUDLY at
   * construction rather than let eviction misfire in production (see the ctor).
   */
  readonly store?: RateLimitStore;

  /** The bucket's ceiling — the most tokens it can ever hold. */
  readonly capacity: number;

  /** How fast the bucket refills, in tokens per second. */
  readonly refillPerSecond: number;

  /**
   * Routed into the auto-constructed {@link MemoryRateLimitStore} as its
   * `onSaturated` signal — fired once when the store's hard cap starts shedding
   * throttled buckets under a flood (see {@link MemoryRateLimitStoreOptions.onSaturated}).
   * Ignored when a `store` is injected (that store carries its own). Defaults, via
   * the store, to a `console.warn` with a stable code.
   *
   * Synchronous by design (unlike the awaited, request-context `onDenied`): it
   * fires deep inside the store's atomic read-modify-write, which `check` does not
   * await, so an async hook could neither be awaited (it would break the "nothing
   * interleaves" store contract) nor have its promise handled. Route to an async
   * sink by enqueuing, not awaiting.
   */
  readonly onSaturated?: () => void;

  /** Injected for determinism; defaults to the system clock. */
  readonly clock?: Clock;
}

const MS_PER_SECOND = 1000;

/**
 * A token-bucket rate limiter.
 *
 * Each key owns a bucket that refills continuously at `refillPerSecond`, capped
 * at `capacity`. A `check` first credits the tokens accrued since the bucket was
 * last touched, then either spends `cost` (allow) or reports how long the caller
 * must wait for the deficit to refill (deny). State is persisted on every check,
 * so the store — not process memory — is the source of truth.
 */
export class RateLimiter {
  private readonly store: RateLimitStore;

  private readonly capacity: number;

  private readonly refillPerSecond: number;

  private readonly clock: Clock;

  constructor(options: RateLimiterOptions) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.clock = options.clock ?? systemClock;

    // The limiter OWNS the store↔limiter capacity pairing, because a drift breaks
    // self-eviction SILENTLY — the one thing eviction was built never to do:
    //   • store ceiling ABOVE the limiter's → buckets never reach the eviction
    //     point, so the unbounded-Map leak quietly returns; and
    //   • store ceiling BELOW the limiter's → a partially-drained, actively-
    //     throttled bucket whose tokens sit in [storeCap, limiterCap) reads as
    //     "full", is evicted, and re-materializes full on the next check — the
    //     limiter silently WEAKENED / bypassed.
    // So, with no store injected, we build one at our OWN capacity AND refill rate
    // (the common path cannot drift); and an INJECTED MemoryRateLimitStore whose
    // capacity or rate is set must MATCH ours, or we refuse LOUD with a coded error
    // at construction rather than degrade unnoticed. Both feed the store's fullness
    // math (capacity is the eviction ceiling; the rate ages idle buckets), so both
    // must agree. A store with neither set (uncapped, or a SQL/Redis store that
    // self-eviction does not apply to) has nothing to drift, so it is left alone.
    if (options.store instanceof MemoryRateLimitStore) {
      if (options.store.capacity !== undefined && options.store.capacity !== this.capacity) {
        throw new RateLimitError(
          "RATELIMIT_STORE_CAPACITY_MISMATCH",
          `The injected MemoryRateLimitStore's capacity (${options.store.capacity}) must equal the ` +
            `RateLimiter's capacity (${this.capacity}) — a mismatch breaks self-eviction silently.`,
          { storeCapacity: options.store.capacity, limiterCapacity: this.capacity },
        );
      }

      if (
        options.store.refillPerSecond !== undefined &&
        options.store.refillPerSecond !== this.refillPerSecond
      ) {
        throw new RateLimitError(
          "RATELIMIT_STORE_REFILL_MISMATCH",
          `The injected MemoryRateLimitStore's refillPerSecond (${options.store.refillPerSecond}) ` +
            `must equal the RateLimiter's refillPerSecond (${this.refillPerSecond}) — a mismatch ages ` +
            `buckets at the wrong rate and evicts actively-throttled ones.`,
          {
            storeRefillPerSecond: options.store.refillPerSecond,
            limiterRefillPerSecond: this.refillPerSecond,
          },
        );
      }
    }

    this.store =
      options.store ??
      new MemoryRateLimitStore({
        capacity: this.capacity,
        refillPerSecond: this.refillPerSecond,
        // Thread the saturation signal into the store the limiter owns — only when
        // given, so an unwired caller falls through to the store's own loud
        // `console.warn` default (conditional spread: `exactOptionalPropertyTypes`
        // forbids passing an explicit `undefined` for an optional prop).
        ...(options.onSaturated ? { onSaturated: options.onSaturated } : {}),
      });
  }

  /**
   * How many actively-throttled buckets the backing store has shed under its hard
   * cap since construction — the continuous saturation signal, reachable *through
   * the limiter* so the common caller (who let it build its own store) can poll it
   * without a handle to the store. `undefined` when the store is not an in-memory
   * one: a SQL/Redis store accretes rows reclaimed by an explicit sweep, so it has
   * no in-memory cap to saturate. Reads the count only — the store itself stays
   * encapsulated, so this cannot reopen the capacity/refill drift the ctor guards.
   */
  get saturationEvictions(): number | undefined {
    return this.store instanceof MemoryRateLimitStore ? this.store.saturationEvictions : undefined;
  }

  async check(key: string, cost = 1): Promise<RateLimitResult> {
    const now = this.clock();

    // The whole token-bucket decision is the store's `mutate`: the store brackets
    // it in one atomic read-modify-write, so the math never races a shared
    // backend. `mutate` is pure over its input and may run more than once (a SQL
    // store retries it after a first-insert race); we capture the verdict per
    // invocation and the last one — the one the store actually persisted — wins.
    let result!: RateLimitResult;

    await this.store.update(key, (existing) => {
      // A first-seen key starts full; otherwise credit what has accrued since
      // last touch, capped at capacity.
      const tokens = this.refilled(existing, now);

      // Enough in the bucket: spend the cost and persist the drained state.
      if (tokens >= cost) {
        const remaining = tokens - cost;

        result = { allowed: true, remaining: Math.floor(remaining), retryAfterMs: 0 };

        return { tokens: remaining, updatedAt: now };
      }

      // Not enough: report the wait for the deficit and persist the accrued
      // tokens with the new timestamp (so refill keeps advancing across denials).
      const deficit = cost - tokens;
      const retryAfterMs = Math.ceil((deficit / this.refillPerSecond) * MS_PER_SECOND);

      result = { allowed: false, remaining: Math.floor(tokens), retryAfterMs };

      return { tokens, updatedAt: now };
    });

    return result;
  }

  /** Tokens available now: a fresh key is full; a known key earns elapsed * rate, capped. */
  private refilled(existing: BucketState | undefined, now: number): number {
    if (existing === undefined) return this.capacity;

    // The same formula the store uses to age buckets — shared so the two can never
    // disagree on how full a bucket is (see `refilledTokens`).
    return refilledTokens(existing, now, this.capacity, this.refillPerSecond);
  }
}
