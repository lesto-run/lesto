---
"@lesto/ratelimit": patch
"@lesto/identity": patch
---

Bound the in-memory rate-limit store, and document/soften the "brute-force limiter on by default" behavior change (L-8244c703).

`MemoryRateLimitStore` was an unbounded `Map` that persisted every key on every `update` — including a cost-0 peek and a successful login. Keyed by an attacker-chosen string (`login:<email>`), that is a memory-exhaustion DoS: an unauthenticated flood of distinct emails grows the Map without bound, and even benign traffic leaks one permanent entry per distinct email forever (worst on a long-lived Node process — the deployment the docs call the "real" default). Since F8 (brute-force protection ON by default) this store is now wired out of the box, so the leak ships by default rather than only when opted in.

- **`@lesto/ratelimit`**: `MemoryRateLimitStore` now takes an optional `{ capacity }` and, when given one, **self-evicts a bucket the instant it has fully refilled** (`next.tokens >= capacity` ⇒ `delete`, else `set`). The eviction is lossless: a full bucket is byte-identical to what a first-seen key would materialize, so dropping it and re-materializing it full on the next check yields the identical verdict — while a partially-drained, *actively-throttled* bucket is never full and so is never evicted. This is deliberately NOT an LRU/size cap: dropping the oldest (or any live) bucket under pressure would let a flood of distinct keys push a *targeted* account's still-draining bucket out and reset its count — a limiter bypass. Evicting only on full refill can never do that. The `RateLimitStore` interface is unchanged, and with no `capacity` passed the store keeps its original always-persist behavior (back-compat).
- **`@lesto/identity`**: the default `loginRateLimiter`/`totpRateLimiter` now construct their `MemoryRateLimitStore` with `capacity: 5`, so the built-in throttle no longer accretes an unbounded Map.

**Behavior-change note (F8, L-92479cc7).** Brute-force protection has been ON by default since F8: after **5 failed attempts / 15 minutes** against one account, `login` now refuses with `IDENTITY_LOGIN_THROTTLED` where it previously returned `IDENTITY_INVALID_CREDENTIALS` indefinitely (the same for the second-factor paths via `IDENTITY_TOTP_THROTTLED`). Apps or tests that relied on unlimited attempts opt out deliberately with `loginRateLimiter: false` (and/or `totpRateLimiter: false`).

**Edge caveat.** The default limiter is in-memory — a real per-process floor on a long-lived Node server, but reset on every isolate recycle on Cloudflare Workers/edge, so "on by default" over-promises there (the per-account cap does not hold across requests). `createIdentity` now emits a single `isWorkerd()`-gated `console.warn` at wiring time (not per `login()`) when a default limiter is relied on under workerd, steering callers to a durable `sqlRateLimitStore`-backed limiter for a fleet-wide cap.

Additive and back-compat; `patch` under 0.x lockstep versioning.
