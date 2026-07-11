---
"@lesto/identity": patch
---

The secure-by-default in-memory brute-force limiter is now memory-bounded (L-976b4302).

`defaultRateLimiter` (login + TOTP, ON by default per F8) previously handed the `RateLimiter` a `MemoryRateLimitStore` it built itself, whose Map grew monotonically under an adversarial flood of distinct `login:<email>` keys — one permanent entry per email until the process restarted. Now that `@lesto/ratelimit`'s store carries a hard cap, this default is bounded: it stops hand-constructing the store and lets the `RateLimiter` build its own at the limiter's own capacity and refill rate (L-e2d3493b — the limiter owns the pairing, so nothing can drift, and the built store is memory-bounded and refill-aware). No behavior change beyond the bound; the docs that described the now-fixed monotonic-growth residual are corrected. The default remains a per-*process* floor — durability and fleet-wide reach still call for a `sqlRateLimitStore`-backed limiter. `patch` under 0.x lockstep versioning.
