---
title: "Cache"
description: "A TTL cache for Lesto — one expiry policy over pluggable in-memory or SQL-backed stores, with an injectable clock and single-flight stampede protection."
section: Batteries
order: 13
---

# Cache

`@lesto/cache` is a TTL cache built on one separation: a `Cache` owns the expiry
policy and the clock, and a pluggable *store* owns nothing but remembering
entries verbatim. The store is dumb — it keeps a key, a value, and a deadline,
and forgets them on command. Liveness is decided in exactly one place, so the
same cache logic runs unchanged over a process-local `Map` or a SQL table that
survives a restart.

## Create a cache

A `Cache` takes a `store` and an optional `clock`. The default
[`MemoryStore`](#stores) is a plain in-process `Map` — zero-dependency and
entirely ephemeral. `fetch(key, produce, options)` is the core verb: on a hit
`produce` never runs; on a miss or an expired entry it produces a value, writes
it, and returns it.

```ts
import { Cache, MemoryStore } from "@lesto/cache";

const cache = new Cache({ store: new MemoryStore() });

// Hit returns the cached user; miss loads, caches for 60s, and returns.
const user = await cache.fetch("user:1", () => loadUser(1), { ttlMs: 60_000 });
```

`WriteOptions` carries a single knob, `ttlMs`. Omit it and the entry never
expires; the deadline is stored as an absolute epoch-ms instant, not a relative
TTL, so a persisted store can be re-read by another process without recomputing
anything.

## Read, write, and invalidate

The lower-level verbs are there when `fetch` is too coarse. `read` returns the
live value or `undefined` — and evicts an expired entry as it notices it, so a
dead row never lingers behind a hot key. `write` stamps a value with an optional
TTL. `delete` forgets one key; `clear` forgets every key.

```ts
await cache.write("flag:beta", true, { ttlMs: 5 * 60_000 });

const beta = await cache.read<boolean>("flag:beta"); // boolean | undefined

await cache.delete("flag:beta"); // forget one key
await cache.clear(); // forget all
```

Every verb is `async` because a store may be backed by a networked engine —
the shape is async even when a `MemoryStore`'s work is synchronous.

## Single-flight with `remember`

`remember` is `fetch` with stampede protection: when many callers miss the same
key at once, `compute` runs **once** and every caller shares its result. The
in-flight ledger is process-local by design — it coalesces the thundering herd
within one node, which is exactly where it forms.

```ts
// Ten concurrent misses → one loadProfile call; all ten await the same promise.
const profile = await cache.remember(
  "profile:42",
  () => loadProfile(42),
  { ttlMs: 30_000 },
);
```

A failed `compute` is never cached — the rejection flows to every waiter and the
next call is free to retry. And invalidation wins the race: a `delete` or
`clear` issued while a compute is in flight suppresses that compute's write, so
a value the caller explicitly discarded is never silently resurrected.

## Stores

A store satisfies the `CacheStore` contract — `get`, `set`, `delete`, `clear` —
and knows nothing about expiry. Two ship in the box.

`MemoryStore` lives and dies with the process. Reach for `sqlStore` when the
cache must survive a restart or be shared across workers. Install the schema
once, then build the store over any handle that speaks the minimal
`SqlDatabase` surface this package defines — a driver-agnostic shape
structurally compatible with what [`@lesto/db`](/batteries/data) exposes:

```ts
import { Cache, installCacheSchema, sqlStore } from "@lesto/cache";

await installCacheSchema(db); // CREATE TABLE IF NOT EXISTS lesto_cache
// On Postgres, pass the dialect so expires_at is BIGINT, not INTEGER:
// await installCacheSchema(db, "postgres");

const cache = new Cache({ store: sqlStore(db) });
```

Values are JSON-encoded on write and parsed on read, so a SQL-backed cache holds
any JSON-representable value. Writes upsert on the key, so re-caching a key
overwrites rather than duplicates.

## Sweeping expired rows

The `Cache` evicts an expired entry on *read*, so only entries that are never
read again accumulate. A `SqlCacheStore` adds `sweep(now)` for exactly that
case: it deletes every row whose deadline has passed and returns how many it
removed. A never-expiring entry (`NULL` deadline) is left untouched.

```ts
const store = sqlStore(db);
const cache = new Cache({ store });

// The caller owns the cadence — the store starts no timer. Run it on a
// schedule, e.g. from a @lesto/queue retention recipe.
const removed = await store.sweep(Date.now());
```

Wire `sweep` into a periodic job ([Background queue](/batteries/queue)) rather
than a `setInterval` you have to babysit — the store deliberately starts no
timer of its own.

## Testing with an injected clock

Time is injectable. `Cache` reads the wall clock through a `Clock` — a
`() => number` returning epoch ms — defaulting to the exported `systemClock`.
Tests pin a frozen one so every expiry path is deterministic and nothing waits.

```ts
import { Cache, MemoryStore } from "@lesto/cache";

let now = 1_000;
const cache = new Cache({ store: new MemoryStore(), clock: () => now });

await cache.write("k", "v", { ttlMs: 100 });
now = 1_050;
await cache.read("k"); // "v" — still live
now = 1_200;
await cache.read("k"); // undefined — expired, and evicted on this read
```

## Notes and gotchas

- **The store is policy-free.** A `CacheStore` only remembers and forgets; the
  `Cache` decides liveness against its clock. That's why expiry behaves
  identically across `MemoryStore` and `sqlStore` — there is one expiry code
  path, not one per store.
- **`undefined` is the miss sentinel.** `read` and `fetch` use `undefined` to
  mean "not cached." Caching a literal `undefined` value is therefore
  indistinguishable from a miss; cache `null` or a wrapper object instead.
- **`remember` is single-node.** The in-flight ledger coalesces concurrent
  misses *within one process*. Two separate workers can still both compute on a
  cold key — cross-process stampede control is a different tool (an atomic DB
  lock), not this.
- **Failures aren't cached.** A rejected `compute` leaves the cache exactly as
  it was, so the next call retries. Only successful values are written.
- **TTL stores an absolute deadline.** Omitting `ttlMs` means *never expires*
  (`null` deadline). Because the deadline is epoch-ms, a `sqlStore` re-read by
  another process honors the original expiry without recomputation.
- **Postgres needs the dialect.** Pass `"postgres"` to `installCacheSchema` so
  `expires_at` is `BIGINT` — an epoch-ms deadline overflows Postgres's 32-bit
  `int4`. On SQLite the default `INTEGER` is correct.
- **`sweep` is opt-in and caller-driven.** Read-eviction handles hot keys;
  `sweep(now)` reclaims cold expired rows on a cadence you own.

For how the underlying database handle is built and shared, see
[Data layer](/batteries/data) and the [migrations](/batteries/migrations) guide.
