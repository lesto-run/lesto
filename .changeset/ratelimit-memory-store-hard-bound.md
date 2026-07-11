---
"@lesto/ratelimit": patch
---

`MemoryRateLimitStore` now has a real hard memory bound under adversarial floods (L-976b4302).

Eviction-on-refill (L-8244c703) only ever drops a bucket sitting *at* the ceiling, so it bounds the benign/idle case but not an adversarial one: a cost-1 request — a failed login, every per-IP request — drains its bucket *below* full, so a flood of distinct attacker-chosen keys accretes below-ceiling buckets that eviction-on-refill will not reclaim until they slowly refill. The Map grew monotonically toward memory exhaustion. This affected **both** secure-by-default in-memory stores: identity's per-account brute-force limiter and the kernel's per-client-IP `rateLimit()` middleware (ADR 0016), the more universal of the two.

The bound lives at the store, so every `MemoryRateLimitStore` inherits it:

- **A hard `maxBuckets` cap** (default 10,000, matching `@lesto/cache`'s `DEFAULT_MAX_ENTRIES`; a non-positive-integer cap throws at construction). Over budget, the store evicts the bucket **closest to full** — the least-throttled, hence safest to drop, so a targeted account/IP actively being throttled is the *farthest* from full and the LAST thing evicted. A flood of distinct keys can no longer push a throttled bucket out of the Map (an LRU/oldest-first cap could — that would be a limiter bypass).
- **A lazy full-refill sweep** on overflow reclaims, in one pass, buckets that refilled to the ceiling while idle and were never re-checked (refill-aware stores only) — dead buckets are reclaimed before a live one is ever touched.
- `MemoryRateLimitStore` now accepts `refillPerSecond` (so it can age buckets to compute fullness) and `maxBuckets`. `refillPerSecond` is `public readonly` and, like `capacity` (L-e2d3493b), the `RateLimiter` enforces an injected store's rate matches its own — a mismatch throws a coded `RateLimitError` (`RATELIMIT_STORE_REFILL_MISMATCH`). The refill formula is now shared by the limiter and the store so their fullness math cannot diverge.
- The `RateLimiter`'s auto-constructed store is built at the limiter's `capacity` **and** `refillPerSecond`, so it is refill-aware and bounded with no drift. The rate-limit middleware now lets the limiter construct the store: its per-IP store is bounded (closing the residual the L-e2d3493b changeset deferred here).

Back-compat: additive options, unchanged public API; a bare `new MemoryRateLimitStore()` is now bounded at the default cap (it was effectively unbounded) but otherwise behaves as before. `patch` under 0.x lockstep versioning.
