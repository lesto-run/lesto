---
"@lesto/ratelimit": minor
"@lesto/kernel": minor
---

Harden the rate-limit stores: enforce the memory store's clock contract, and give the SQL store a real sweep driver.

**Memory store clock (defense-in-depth).** `MemoryRateLimitStore` previously aged every *other* bucket in its overflow eviction against the just-written bucket's `updatedAt`, trusting it as the reference "now". A future/attacker-derived `updatedAt` on one bucket could therefore compute all its neighbours as fully refilled and mass-evict live throttle state. The store now carries its own injected `clock` (default the shared `systemClock`) and ages against `this.clock()`, so a single bogus `updatedAt` only makes *that* bucket read un-refilled (last to be evicted) and can never become the reference clock. A `RateLimiter` threads its own clock into the auto-built store; injecting a *refill-aware* store under a **different** clock is now refused at construction with `RATELIMIT_STORE_CLOCK_MISMATCH` (the "two limiters, one store, two clocks" mass-evict case). All-default (`systemClock`) callers, and non-refill-aware injected stores, are unaffected.

New: `MemoryRateLimitStoreOptions.clock`, public readonly `MemoryRateLimitStore.clock`, error code `RATELIMIT_STORE_CLOCK_MISMATCH`.

**SQL store sweep.** Wiring a DB swaps the in-memory store for `sqlRateLimitStore`, moving unbounded growth from RAM to `lesto_rate_limits` rows — reclaimed only when someone calls `sweep()`. The framework started no cadence, so "durable" did not mean "bounded". New `startRateLimitSweep(store, opts)` is a process-safe driver: no-overlap guard, injectable timer seam, coded error routing, and an **`unref()`'d** timer so a sweep never pins the event loop or leaks across a test; its handle's `stop()` drains gracefully. `secureStack` gains an opt-in `rateLimitSweep` option (torn down via `stopManagedRateLimitSweeps()`). It is deliberately opt-in, not default-on: `lesto_rate_limits` is shared (identity's brute-force limiters key into it) and sweeps are table-wide, so a framework-chosen retention could delete a still-locked-out login bucket — the operator, who knows every co-tenant's horizon, owns `retentionMs`.

New: `startRateLimitSweep`, `RateLimitSweepOptions`, `RateLimitSweepHandle`, `DEFAULT_RATELIMIT_SWEEP_INTERVAL_MS`, `DEFAULT_RATELIMIT_SWEEP_RETENTION_MS`, `SecureStackOptions.rateLimitSweep`.
