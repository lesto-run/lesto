---
"@lesto/ratelimit": patch
---

`MemoryRateLimitStore` now signals when its hard cap sheds throttled buckets — the memory bound is no longer silent (L-b5bae0a4).

The `maxBuckets` bound (L-976b4302) evicted actively-throttled buckets under a distinct-key flood with no signal at all, so an operator couldn't tell the difference between a healthy limiter and one shedding throttle state under attack — the bound hid exactly what it defends against (ADR 0011, loud-when-wrong). Now:

- **A loud-by-default signal.** The first time the cap evicts a live (below-ceiling) bucket, the store fires `onSaturated` — by default a `console.warn` carrying the stable, machine-branchable `RATELIMIT_STORE_SATURATED_CODE`. It fires **once** per store (a sustained flood is not a log flood), mirroring the existing `onUnknownClient` warn-once pattern. Inject `onSaturated` to route it to a real logger, or pass a no-op to silence it. The lossless full-refill **sweep stays silent** — only the closest-to-full drop of a throttled bucket, the actual attack signal, fires.
- **A continuous counter.** `store.saturationEvictions` (readonly) counts every throttled-bucket eviction — the ongoing signal to poll while the hook fires just once. `maxBuckets` is now `public readonly` too, so an operator can watch saturation (`size / maxBuckets`) climb *before* the cap ever engages.
- **Threaded through the seams.** `RateLimiterOptions.onSaturated` and `rateLimit()`'s `RateLimitOptions.onSaturated` route the hook into the store the limiter/middleware auto-builds, so the kernel per-IP limiter and identity's default brute-force limiter surface it without anyone injecting a store. Ignored when a pre-built `store`/`limiter` is supplied (that one carries its own). New exports: `RATELIMIT_STORE_SATURATED_CODE`, `MemoryRateLimitStoreOptions`.

Additive and back-compat: the default `console.warn` only fires when the cap is actually shedding throttled buckets (never in ordinary operation), and all new options are optional. `patch` under 0.x lockstep versioning.
