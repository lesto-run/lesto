import { RateLimitError } from "./errors";
import { refilledTokens } from "./refill";
import { MemoryRateLimitStore } from "./store";
import { systemClock } from "./time";

import type { BucketState, Clock, RateLimitResult, RateLimitStore } from "./types";

/**
 * The stable code carried by the dead-`onSaturated` warning — a coded *log* signal,
 * not a thrown `RateLimitError`. Injecting a `store` (RateLimiter) or a `limiter`
 * (`rateLimit`) makes an `onSaturated` passed at that level inert: the hook is only
 * ever routed into the store the limiter builds *itself*, and an injected store/limiter
 * already carries its own saturation signal. That is a lower-severity observability
 * footgun than the capacity/refill drift the ctor THROWS on (the limiter still works;
 * only a custom sink is dropped), so it warns loudly rather than crashing construction.
 * Logs and ops tooling branch on this code; mirrors `RATELIMIT_UNKNOWN_CLIENT_CODE` and
 * `RATELIMIT_STORE_SATURATED_CODE`.
 */
export const RATELIMIT_DEAD_ONSATURATED_CODE = "RATELIMIT_DEAD_ONSATURATED";

export interface RateLimiterOptions {
  /**
   * Where buckets live between checks. OPTIONAL: omit it and the limiter builds
   * its own {@link MemoryRateLimitStore} at *its own* `capacity` and
   * `refillPerSecond`, so the store's eviction math can never drift from the
   * limiter's — the common path is drift-proof by construction. Inject one to
   * share a store across limiters or to back the limiter with SQL/Redis. An
   * injected {@link MemoryRateLimitStore} whose `capacity` or `refillPerSecond`
   * is set MUST equal the values below, and — when it is refill-aware (both set) —
   * its `clock` MUST be the same function as {@link clock}; the limiter refuses a
   * mismatch on any of the three LOUDLY at construction rather than let eviction
   * misfire in production (see the ctor).
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
   * Routed ONLY into that auto-built store: when a `store` is injected the limiter has
   * no store to thread it into (that store carries its own), so passing both is dead
   * config and WARNS once at construction (coded {@link RATELIMIT_DEAD_ONSATURATED_CODE})
   * rather than dropping it silently. Defaults, via the store, to a `console.warn` with
   * a stable code.
   *
   * Synchronous by design (unlike the awaited, request-context `onDenied`): it
   * fires deep inside the store's atomic read-modify-write, which `check` does not
   * await, so an async hook could neither be awaited (it would break the "nothing
   * interleaves" store contract) nor have its promise handled. Route to an async
   * sink by enqueuing, not awaiting.
   */
  readonly onSaturated?: () => void;

  /**
   * Injected for determinism; defaults to the system clock. Threaded into the
   * auto-built {@link MemoryRateLimitStore} as its eviction reference clock, so the
   * store ages buckets against the exact source that stamps every `updatedAt`. An
   * injected refill-aware store MUST carry this same clock (see {@link store}).
   */
  readonly clock?: Clock;
}

const MS_PER_SECOND = 1000;

/**
 * The dead-`onSaturated` warning for {@link RateLimiter}: `onSaturated` was passed
 * alongside an injected `store`, but the limiter threads `onSaturated` only into the
 * store it builds *itself* — an injected store owns its own saturation signal, so the
 * limiter-level hook is inert. One `console.warn` carrying the stable
 * {@link RATELIMIT_DEAD_ONSATURATED_CODE}; fired once, at construction (the ctor runs
 * once per limiter), so it is never a per-request flood. Mirrors the middleware's
 * `warnUnknownClient` and the store's `warnStoreSaturated` coded signals.
 */
function warnDeadOnSaturated(): void {
  console.warn(
    `[${RATELIMIT_DEAD_ONSATURATED_CODE}] onSaturated was passed to the RateLimiter alongside an ` +
      `injected store, but onSaturated is routed only into the store the limiter builds itself — an ` +
      `injected store owns its own saturation signal, so this hook is dead. Set onSaturated on the ` +
      `injected MemoryRateLimitStore instead (a SQL/Redis store has no in-memory cap to saturate), or ` +
      `omit the store to let the limiter build one at its own capacity/refillPerSecond.`,
  );
}

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

    // Dead-config guard: `onSaturated` reaches only the store this limiter builds
    // itself (the `??` below skips that build when a store is injected), so passing
    // BOTH an injected store AND onSaturated silently drops the hook. Unlike the
    // capacity/refill drift below — a silent CORRECTNESS hazard that must THROW —
    // this is an observability footgun: the limiter still throttles correctly and the
    // injected store keeps its own saturation signal, so we warn LOUDLY (coded, once
    // per limiter) rather than crash construction. What we do NOT do is silently
    // reroute the hook into the injected store — that store owns its own.
    if (options.store !== undefined && options.onSaturated !== undefined) {
      warnDeadOnSaturated();
    }

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

      // The THIRD paired dimension (L-2dc55e6c): a refill-aware store ages every
      // OTHER bucket, on overflow, against ITS reference clock — which must be the
      // same clock that stamps each bucket's `updatedAt`, i.e. ours. Refuse a store
      // whose clock is a *different* function from the limiter's: that is exactly
      // the "one store shared by two limiters under different clocks" foot-gun, in
      // which the sweep would age one limiter's buckets against the other's `now`
      // and mass-evict live throttle state. Enforced ONLY when the store is
      // refill-aware (both capacity and rate set) — the only configuration in which
      // the clock is consulted at all; an uncapped or rate-less store ranks by
      // stored tokens and never reads the clock, so nothing can drift. The default
      // clock is a shared singleton (`systemClock`), so the all-default case matches
      // by reference and never trips this.
      if (
        options.store.capacity !== undefined &&
        options.store.refillPerSecond !== undefined &&
        options.store.clock !== this.clock
      ) {
        throw new RateLimitError(
          "RATELIMIT_STORE_CLOCK_MISMATCH",
          `The injected refill-aware MemoryRateLimitStore's clock must be the SAME function as the ` +
            `RateLimiter's clock — the store ages buckets against its clock while the limiter stamps ` +
            `updatedAt with its own, so two different clocks let the overflow sweep mass-evict live ` +
            `throttle state. Pass the same clock to both, or omit the store to let the limiter build it.`,
          { sameClock: false },
        );
      }
    }

    this.store =
      options.store ??
      new MemoryRateLimitStore({
        capacity: this.capacity,
        refillPerSecond: this.refillPerSecond,
        // Thread the limiter's OWN clock into the store it builds, so the store ages
        // buckets against the exact source that stamps every `updatedAt` — no second
        // clock to drift; the common path is drift-proof by construction.
        clock: this.clock,
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
