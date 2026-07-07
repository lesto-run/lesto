# examples/cache — read-through caching over HTTP

Wires **`@lesto/cache`** behind real HTTP routes to show every cache behavior that
only shows up end-to-end: read-through misses, hits that never touch the origin,
single-flight coalescing of a thundering herd, invalidation, TTL expiry, and the
SQL store's `sweep` retention verb — all on a **persistent SQLite store** with an
**injected clock**.

## What it shows

A "reports" service where producing a report is expensive (a slow origin). The
cache fronts that origin:

| Route                          | Behavior                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /reports/:id`             | Read-through via `cache.remember`: a miss computes + caches; a hit replays; concurrent misses **coalesce into one** origin call. |
| `POST /reports/:id/invalidate` | `cache.delete` — the next GET recomputes (invalidation wins any in-flight compute).                                              |
| `POST /cache/sweep`            | `store.sweep(now)` — reclaims expired rows that were never re-read.                                                              |

The report carries a `generatedAt` stamp from the injected clock, so a hit is
provable (identical stamp) and a recompute is provable (a fresh stamp once the
clock has moved).

Only `@lesto/cache`'s public API is used for caching: `Cache`, `sqlStore`,
`installCacheSchema`, `systemClock`, and the `Clock` / `SqlCacheStore` types. The
routes are plain `@lesto/web`; the database is `@lesto/runtime`'s `openSqlite`.

## How to run

```bash
bun run examples/cache/run.ts
```

Boots on an in-memory SQLite database with the real system clock and a slow
origin, then drives the journey through the HTTP routes — miss → hit → a burst of
concurrent misses that collapse to one origin call → invalidate → miss → sweep —
printing the origin's load count at each step so you can see the cache working.

## How it's tested (the QA gate)

```bash
bun run --filter '@lesto/example-cache' test
```

The journey test (`test/cache.test.ts`) drives the routes with a **frozen clock**
and asserts what only an end-to-end wiring can prove:

- a repeat GET is a hit — the origin runs exactly once;
- eight concurrent misses for a cold key coalesce into **one** origin call;
- a mutation invalidates, forcing a recompute;
- an entry one tick past its TTL is a miss again (fresh `generatedAt`);
- a warm key survives a "restart" — a second app on the same database serves it
  from SQL without touching its own origin;
- `sweep` reclaims two expired rows that were never re-read.

## DX findings

Wiring this example surfaced no sharp edges: `openSqlite`'s handle satisfies
`@lesto/cache`'s SQL seam directly (no adapter, no cast), and `remember`'s
single-flight is the natural default for an HTTP read-through. The one ergonomic
note is that hit/miss is not observable from `remember`'s return value alone —
this example counts origin calls to prove it, which is the right shape for a demo
but means a production app wanting hit-rate metrics must instrument the origin (or
`read` before `remember`, losing single-flight). A cache-level metrics hook is a
possible follow-up for `@lesto/cache`.
