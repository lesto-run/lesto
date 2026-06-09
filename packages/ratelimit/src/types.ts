/**
 * The vocabulary of the rate limiter.
 *
 * The limiter depends on a *minimal store surface* — not on any one backend.
 * A Map satisfies it today; a SQL- or Redis-backed store will satisfy the same
 * shape tomorrow, and the limiter never knows the difference.
 */

/** A single bucket's persisted state. `updatedAt` is epoch milliseconds. */
export interface BucketState {
  readonly tokens: number;
  readonly updatedAt: number;
}

/** Where buckets live between checks. Synchronous by design — a check is hot. */
export interface RateLimitStore {
  get(key: string): BucketState | undefined;
  set(key: string, state: BucketState): void;
}

/** A clock we can stop. Injected wherever time matters, so tests are deterministic. */
export type Clock = () => number;

/** The verdict for a single `check`. */
export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}
