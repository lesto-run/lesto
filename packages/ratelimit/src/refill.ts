import type { BucketState } from "./types";

const MS_PER_SECOND = 1000;

/**
 * Tokens available in a bucket at `now` — the pure token-bucket refill formula.
 *
 * Shared, deliberately, by the two places that must agree on how full a bucket
 * is: the {@link RateLimiter}, which *spends* against it, and the
 * {@link MemoryRateLimitStore}, which *reads* it to decide when a bucket has
 * refilled enough to evict. Were the two to compute fullness differently, the
 * store could drop a bucket the limiter still considers throttled — the exact
 * silent store↔limiter drift the limiter's capacity guard exists to forbid — so
 * the formula lives in one function neither can fork.
 *
 * Continuous refill at `refillPerSecond`, credited from the bucket's last touch
 * and capped at `capacity`. A clock that appears to run backwards credits zero
 * rather than debiting (`Math.max(0, …)`), so computed fullness is monotone in
 * elapsed time and can never dip below what the bucket already held.
 */
export function refilledTokens(
  state: BucketState,
  now: number,
  capacity: number,
  refillPerSecond: number,
): number {
  const elapsedSeconds = Math.max(0, now - state.updatedAt) / MS_PER_SECOND;

  return Math.min(capacity, state.tokens + elapsedSeconds * refillPerSecond);
}
