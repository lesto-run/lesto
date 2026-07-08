# examples/cache — read-through caching over HTTP

Wires **`@lesto/cache`** behind real HTTP routes to show every cache behavior that
only shows up end-to-end: read-through misses, hits that never touch the origin,
single-flight coalescing of a thundering herd, invalidation, TTL expiry, and the
SQL store's `sweep` retention verb — all on a **persistent SQLite store** with an
**injected clock**. A second, shorter leg drives the other store `@lesto/cache`
ships — the ephemeral in-memory **`MemoryStore`** — so both stores are shown.

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

Only `@lesto/cache`'s public API is used for caching: `Cache`, `MemoryStore`,
`sqlStore`, `installCacheSchema`, `systemClock`, and the `Clock` / `SqlCacheStore`
types. The routes are plain `@lesto/web`; the database is `@lesto/runtime`'s
`openSqlite`. The two stores are interchangeable behind the same `Cache` API —
swap `sqlStore(handle)` for `new MemoryStore()` and every behavior above still
holds; only persistence and `sweep` (SQL-only) differ.

## How to run

```bash
bun run examples/cache/run.ts
```

Boots the SQL store on an ephemeral `:memory:` SQLite database with the real
system clock and a slow origin, then drives the journey through the HTTP routes —
miss → hit → a burst of concurrent misses that collapse to one origin call →
invalidate → miss → sweep —
printing the origin's load count at each step so you can see the cache working. A
final leg then drives the in-memory `MemoryStore` directly (miss → hit → TTL
expiry, on a controllable clock) to show the same behaviors on the other store.

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
- `sweep` reclaims two expired rows that were never re-read;
- the in-memory `MemoryStore`, driven directly against the `Cache` API, shows the
  same miss → hit → TTL-expiry read-through as the SQL store.

## How to deploy / run the hosted leg

```bash
bun run examples/cache/serve.ts
```

`buildApp` returns a bare `@lesto/web` app, not a bootable one — `serve.ts` wraps
it with `@lesto/kernel`'s `createApp` (installing the durable-store schema
alongside the cache schema `buildApp` already installs) and serves THAT behind a
real `node:http` server (`@lesto/runtime`'s `serveWithGracefulShutdown`), on a
FILE-backed SQLite database (`DB_PATH`, defaults to `./cache.db`) rather than
`run.ts`'s `:memory:` — so a warm key survives killing and restarting the
**process itself**, not just a second `buildApp` call in the same run:

```bash
curl localhost:3000/reports/alpha    # miss
curl localhost:3000/reports/alpha    # hit
# kill the process, `bun run serve.ts` again, then — inside the 60s TTL:
curl localhost:3000/reports/alpha    # still a hit, served from the SQL store
```

**Not run in this sandbox** — starting a server is blocked here. `serve.ts` is
typechecked and oxlint/oxfmt-clean, and its wiring (`buildApp` → `createApp` →
`serveWithGracefulShutdown`) mirrors the pattern every hosted `serve.ts` in the
gallery uses (see `examples/mailing-lists/serve.ts`); running it and confirming
the restart-persistence behavior above is a manual follow-up.

## Deploy to Cloudflare (the edge leg) — LIVE

```bash
bun run examples/cache/deploy   # bun alchemy.run.ts
```

`worker.ts` runs the **same app** on the Cloudflare edge, backed by **D1**
instead of a file. `buildApp` already accepts any `@lesto/cache` `SqlDatabase`
handle, so the only change is the substrate: `d1ToSqlDatabase(env.DB)` wraps the
D1 binding in that surface, and `installCacheSchema` + `sqlStore` run against it
unchanged (the SQL cache store uses only `prepare`/`exec`, which D1 supports). A
warm key now lives in D1, so it survives the edge's ephemeral isolates.

`alchemy.run.ts` (ADR 0044 — Alchemy IaC, no `wrangler.toml`) declares the Worker
+ its D1 database and, after `finalize()`, runs a **post-deploy smoke**: it GETs
the same report twice and asserts the second is a **hit served from D1**
(identical `generatedAt` — the origin did not recompute). CI runs exactly this on
every push to main (`.github/workflows/deploy-examples.yml`), so "it deploys AND
the cache works on the edge" is machine-checked, not a manual click-through.

**Honest claim:** this is a genuinely live Cloudflare deploy with a behavioral
proof (a warm D1-backed cache hit on the deployed `workers.dev` URL). There is no
manual hop — unlike the mail example, nothing here waits on external onboarding.

## DX findings

Wiring this example surfaced no sharp edges: `openSqlite`'s handle satisfies
`@lesto/cache`'s SQL seam directly (no adapter, no cast), and `remember`'s
single-flight is the natural default for an HTTP read-through. The one ergonomic
note is that hit/miss is not observable from `remember`'s return value alone —
this example counts origin calls to prove it, which is the right shape for a demo
but means a production app wanting hit-rate metrics must instrument the origin (or
`read` before `remember`, losing single-flight). A cache-level metrics hook is a
possible follow-up for `@lesto/cache`.
