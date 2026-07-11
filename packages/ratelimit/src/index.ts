/**
 * @lesto/ratelimit — token-bucket rate limiting over a pluggable store.
 *
 *   const limiter = new RateLimiter({
 *     store: new MemoryRateLimitStore(),
 *     capacity: 10,
 *     refillPerSecond: 1,
 *   });
 *
 *   const { allowed, remaining, retryAfterMs } = await limiter.check("user:42");
 *   if (!allowed) sleep(retryAfterMs);
 */

export { RateLimiter } from "./limiter";
export type { RateLimiterOptions } from "./limiter";

export {
  rateLimit,
  RATELIMIT_DENIED_KIND,
  RATELIMIT_UNKNOWN_CLIENT_CODE,
  UNKNOWN_CLIENT_KEY,
} from "./middleware";
export type { RateLimitOptions } from "./middleware";

export { MemoryRateLimitStore, RATELIMIT_STORE_SATURATED_CODE } from "./store";
export type { MemoryRateLimitStoreOptions } from "./store";

export { installRateLimitSchema, isUniqueViolation, sqlRateLimitStore } from "./sql-store";
export type { Dialect, SqlRateLimitStore } from "./sql-store";

export { RateLimitError } from "./errors";
export type { RateLimitErrorCode } from "./errors";

export { systemClock } from "./time";

export type {
  BucketState,
  Clock,
  RateLimitResult,
  RateLimitStore,
  SqlDatabase,
  SqlStatement,
} from "./types";
