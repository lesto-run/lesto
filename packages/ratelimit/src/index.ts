/**
 * @keel/ratelimit — token-bucket rate limiting over a pluggable store.
 *
 *   const limiter = new RateLimiter({
 *     store: new MemoryRateLimitStore(),
 *     capacity: 10,
 *     refillPerSecond: 1,
 *   });
 *
 *   const { allowed, remaining, retryAfterMs } = limiter.check("user:42");
 *   if (!allowed) sleep(retryAfterMs);
 */

export { RateLimiter } from "./limiter";
export type { RateLimiterOptions } from "./limiter";

export { MemoryRateLimitStore } from "./store";

export { systemClock } from "./time";

export type { BucketState, Clock, RateLimitResult, RateLimitStore } from "./types";
