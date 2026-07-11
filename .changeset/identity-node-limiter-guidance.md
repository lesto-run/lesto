---
"@lesto/identity": patch
---

Surface the in-memory default-limiter memory residual on the NODE path (docs) (L-974020ef).

The `isWorkerd()`-gated wiring-time `console.warn` warns that the default in-memory brute-force limiter resets per isolate on edge — but the long-lived Node deploy, which is the WORST case for the unbounded-growth residual (L-976b4302), got no equivalent signal. Self-eviction only drops a bucket that sits FULL; a *failed* login burns a token, so its `login:<email>` bucket stays below the eviction ceiling for the whole refill window, and an adversarial flood of distinct emails still grows the store's Map.

Per the doc-first steer (no noisy per-request Node warn), the JSDoc on `defaultRateLimiter`, its inner self-eviction comment, and `IdentityOptions.loginRateLimiter` now state plainly that the default in-memory limiter is a per-process **floor, not a hard cap**: under an adversarial distinct-email failed-login flood the store still grows (bounded by flood-rate × window), and a durable, fleet-wide, memory-bounded limiter on a long-lived Node deploy means wiring a `sqlRateLimitStore`-backed `loginRateLimiter` (whose rows a periodic `sweep` reclaims). The existing workerd `console.warn` is unchanged.

Documentation only — no behavior change.
