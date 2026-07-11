---
"@lesto/ratelimit": patch
---

`RateLimiter` now owns and validates its store's capacity, killing the silent `store.capacity != limiter.capacity` drift footgun (L-e2d3493b).

`MemoryRateLimitStore` self-eviction fires at the *store's* `capacity`, while the limiter spends against *its own* `capacity` — the two are one number that MUST agree, and a drift breaks eviction **silently**: a store ceiling above the limiter's means buckets never reach the eviction point (the unbounded-Map leak quietly returns), and a store ceiling below it means a partially-drained, actively-throttled bucket whose tokens sit in `[storeCap, limiterCap)` reads as "full", gets evicted, and re-materializes full — the limiter silently weakened (the exact bypass eviction was built to forbid). Nothing enforced or documented the invariant.

- `RateLimiterOptions.store` is now **optional**: when omitted, the limiter builds its own `MemoryRateLimitStore` at its own `capacity`, so the common path cannot drift by construction.
- An **injected** `MemoryRateLimitStore` whose `capacity` is set must equal the limiter's `capacity`, or the constructor throws a coded `RateLimitError` (`RATELIMIT_STORE_CAPACITY_MISMATCH`, carrying both ceilings in `details`) — loud at wiring time instead of a silent production degrade. An uncapped store, or a non-`MemoryRateLimitStore` (SQL/Redis) store, has nothing to drift and is left untouched.
- `MemoryRateLimitStore.capacity` is now a public read-only property (exposed for the guard, not as a mutation seam).

Additive and back-compat (no live caller mismatched today; identity + the middleware already fed both ceilings from one constant). The rate-limit middleware's per-IP store stays deliberately uncapped — capping it would be false confidence, since the middleware spends cost 1 on every request so a bucket never sits at the ceiling to evict (the per-IP memory bound is separate, L-976b4302). `patch` under 0.x lockstep versioning.
