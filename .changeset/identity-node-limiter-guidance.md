---
"@lesto/identity": patch
---

Surface the in-memory default-limiter memory residual on the NODE path (docs) (L-974020ef).

The `isWorkerd()`-gated wiring-time `console.warn` warns that the default in-memory brute-force limiter resets per isolate on edge — but the long-lived Node deploy, which is the WORST case for the unbounded-growth residual (L-976b4302), got no equivalent signal. Self-eviction only drops a bucket that sits FULL, and it is lazy (on-access only, no sweep); a *failed* login burns a token, so its `login:<email>` bucket is stored below the eviction ceiling — and because that key is never revisited, it is never re-checked and never evicted, so an adversarial flood of distinct emails grows the store's Map monotonically.

Per the doc-first steer (no noisy per-request Node warn), the JSDoc on `defaultRateLimiter`, its inner self-eviction comment, and `IdentityOptions.loginRateLimiter` now state plainly that the default in-memory limiter is a per-process **floor, not a hard cap**: eviction is lazy on-access (no sweep), so under an adversarial distinct-email failed-login flood — whose keys are never revisited — the store's Map grows **monotonically, one permanent entry per email until the process restarts** (not a steady-state set that entries age out of). A durable, fleet-wide, memory-bounded limiter on a long-lived Node deploy means wiring a `sqlRateLimitStore`-backed `loginRateLimiter` (whose rows a periodic `sweep` reclaims). The existing workerd `console.warn` is unchanged.

Documentation only — no behavior change.
