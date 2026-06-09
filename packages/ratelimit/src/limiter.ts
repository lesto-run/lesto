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

  check(key: string, cost = 1): RateLimitResult {
    const now = this.clock();

    // A first-seen key starts full; otherwise credit what has accrued since last touch.
    const tokens = this.refilled(key, now);

    // Enough in the bucket: spend the cost and persist the drained state.
    if (tokens >= cost) {
      const remaining = tokens - cost;

      this.persist(key, remaining, now);

      return { allowed: true, remaining: Math.floor(remaining), retryAfterMs: 0 };
    }

    // Not enough: leave the bucket untouched and report the wait for the deficit.
    const deficit = cost - tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillPerSecond) * MS_PER_SECOND);

    this.persist(key, tokens, now);

    return { allowed: false, remaining: Math.floor(tokens), retryAfterMs };
  }

  /** Tokens available now: a fresh key is full; a known key earns elapsed * rate, capped. */
  private refilled(key: string, now: number): number {
    const existing = this.store.get(key);

    if (existing === undefined) return this.capacity;

    const elapsedSeconds = (now - existing.updatedAt) / MS_PER_SECOND;
    const accrued = elapsedSeconds * this.refillPerSecond;

    return Math.min(this.capacity, existing.tokens + accrued);
  }

  private persist(key: string, tokens: number, now: number): void {
    const state: BucketState = { tokens, updatedAt: now };

    this.store.set(key, state);
  }
}
