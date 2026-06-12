import { systemClock } from "./time";

import type { BucketState, Clock, RateLimitResult, RateLimitStore } from "./types";

export interface RateLimiterOptions {
  readonly store: RateLimitStore;

  /** The bucket's ceiling — the most tokens it can ever hold. */
  readonly capacity: number;

  /** How fast the bucket refills, in tokens per second. */
  readonly refillPerSecond: number;

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
    this.store = options.store;
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.clock = options.clock ?? systemClock;
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

    const elapsedSeconds = (now - existing.updatedAt) / MS_PER_SECOND;
    const accrued = elapsedSeconds * this.refillPerSecond;

    return Math.min(this.capacity, existing.tokens + accrued);
  }
}
