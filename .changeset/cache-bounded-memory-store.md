---
"@lesto/cache": minor
---

The default `MemoryStore` is now bounded.

Previously the in-memory store was an unbounded `Map` with no eviction, so expired-but-unread entries accumulated forever — a slow leak for any long-lived process. `MemoryStore` now takes `MemoryStoreOptions { maxEntries?, clock? }` (default `maxEntries` 10,000) and evicts on write: expired entries are swept first (using the injected `Clock`, so a dead entry never displaces a live one), then, if still over the cap, the least-recently-used entry is dropped. Access order is tracked cheaply via `Map` insertion order, so `get`/`set` keep LRU recency without a timer — the framework starts no background interval; the caller owns any additional sweep cadence.

The public `CacheStore` contract is unchanged; the bound lives on `MemoryStore`. Callers within the cap see identical behavior.
