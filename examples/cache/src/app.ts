/**
 * examples/cache — the @lesto/cache read-through journey behind real HTTP routes.
 *
 * A tiny "reports" service where producing a report is EXPENSIVE (a slow origin).
 * `Cache.remember` fronts that origin so the interesting cache behaviors all show
 * up at the HTTP boundary:
 *
 *   - the FIRST GET for a key computes and caches it (a miss);
 *   - later GETs inside the TTL replay the cached value (a hit) — the origin is
 *     never touched, provable because the report's `generatedAt` stamp is stable;
 *   - concurrent misses for the SAME key COALESCE into one origin call
 *     (single-flight via `remember`), instead of a thundering herd;
 *   - a mutation INVALIDATES its key, so the next GET recomputes (invalidation
 *     wins the race against any in-flight compute);
 *   - an EXPIRED entry (TTL elapsed) is a miss again;
 *   - the SQL store's `sweep` reclaims expired rows that were never re-read.
 *
 * The store is `@lesto/cache`'s SQL store, so the cache survives a process
 * restart: boot a second app on the same database and a warm key is still a hit
 * (the test proves this). The clock is INJECTED — real time in run.ts, frozen in
 * the test — because expiry is the one behavior a wall-clock test can't drive
 * deterministically.
 *
 * Built as factories so the handlers close over their dependencies rather than
 * reaching for module-scoped globals (the estate/mailing-lists shape).
 */

import { Cache, installCacheSchema, sqlStore } from "@lesto/cache";
import type { Clock, SqlCacheStore, SqlDatabase } from "@lesto/cache";
import { lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";

/** The cache key a report id is stored under. */
function reportKey(id: string): string {
  return `report:${id}`;
}

/** A single computed report. `generatedAt` is the proof of when it was produced. */
export interface Report {
  readonly id: string;
  readonly value: number;
  /** Epoch-ms stamp from the injected clock at PRODUCE time — stable across hits. */
  readonly generatedAt: number;
}

/**
 * The expensive origin the cache fronts.
 *
 * `load` is the slow call a real service would make (a heavy query, a third-party
 * API); `loads` counts how many times it actually ran, which is the hit/miss
 * proof the journey test asserts on. `value` is a deterministic function of the
 * id so a recompute is recognizable only by its fresh `generatedAt`, not a
 * different value.
 */
export interface ReportsOrigin {
  load(id: string): Promise<Report>;
  readonly loads: number;
}

/**
 * A counting origin, clock-stamped and optionally slow.
 *
 * `delayMs` models real latency so run.ts can feel the cost of a miss and the
 * test can open a window in which concurrent misses race (proving single-flight).
 */
export function createReportsOrigin(clock: Clock, delayMs = 0): ReportsOrigin {
  let loads = 0;

  return {
    async load(id: string): Promise<Report> {
      loads += 1;

      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

      // A deterministic "computation": stable per id, so only `generatedAt`
      // changes across a recompute. `generatedAt` is stamped from the SAME clock
      // the cache reads, so a frozen-clock test sees an exact, comparable value.
      return { id, value: id.length * 100, generatedAt: clock() };
    },

    get loads(): number {
      return loads;
    },
  };
}

/** The dependencies the routes close over. */
export interface CacheAppDeps {
  readonly cache: Cache;

  /** The SQL store, exposed here only for its `sweep` retention verb. */
  readonly store: SqlCacheStore;

  readonly origin: ReportsOrigin;

  /** How long a cached report stays live. */
  readonly ttlMs: number;

  /** "Now" for the sweep deadline — the same clock the cache reads for expiry. */
  readonly clock: Clock;
}

/**
 * The routes, closing over the cache + origin they front.
 *
 *   GET  /reports/:id             read-through: cached, single-flighted
 *   POST /reports/:id/invalidate  forget one key (invalidation wins the race)
 *   POST /cache/sweep             reclaim expired rows (the SQL store's retention verb)
 */
export function buildCacheApp(deps: CacheAppDeps): Lesto {
  const { cache, store, origin, ttlMs, clock } = deps;

  return lesto()
    .get("/reports/:id", async (c) => {
      const id = c.param("id");

      // `remember`, not `fetch`: concurrent misses for one key share a single
      // origin call instead of stampeding it. On a hit the origin never runs.
      const report = await cache.remember(reportKey(id), () => origin.load(id), { ttlMs });

      return c.json(report);
    })
    .post("/reports/:id/invalidate", async (c) => {
      // Drop the key so the next GET recomputes. `delete` also abandons any
      // in-flight `remember` lead for this key, so an invalidation issued
      // mid-compute is never undone by that compute resolving late.
      await cache.delete(reportKey(c.param("id")));

      return c.json({ invalidated: true });
    })
    .post("/cache/sweep", async (c) => {
      // The SQL store makes bulk reclamation cheap: `Cache` already evicts an
      // expired entry when it is read, so only never-re-read entries pile up —
      // `sweep(now)` deletes exactly those. The caller owns the cadence.
      const swept = await store.sweep(clock());

      return c.json({ swept });
    });
}

/** What `buildApp` returns: the app plus the handles run.ts / the test need. */
export interface Booted {
  readonly app: Lesto;
  readonly cache: Cache;
  readonly store: SqlCacheStore;
  readonly origin: ReportsOrigin;
}

export interface BuildOptions {
  /** A SQL database handle (from `@lesto/runtime`'s `openSqlite`). */
  readonly handle: SqlDatabase;

  /** Injected for determinism; defaults to the cache's own system clock in run.ts. */
  readonly clock: Clock;

  /** Report TTL in ms. */
  readonly ttlMs: number;

  /** Origin latency in ms — 0 (instant) unless a caller wants to feel/observe it. */
  readonly delayMs?: number;
}

/**
 * Boot the cache app: install the cache schema on the handle, build a SQL-backed
 * store + a clock-injected `Cache`, wire the routes, and hand back the pieces.
 *
 * A single `handle` flows straight into `installCacheSchema` and `sqlStore` — the
 * `@lesto/cache` SQL seam is exactly `@lesto/runtime`'s SQLite handle shape, so
 * there is no adapter and no cast.
 */
export async function buildApp(options: BuildOptions): Promise<Booted> {
  const { handle, clock, ttlMs, delayMs } = options;

  await installCacheSchema(handle);

  const store = sqlStore(handle);
  const cache = new Cache({ store, clock });
  const origin = createReportsOrigin(clock, delayMs);

  const app = buildCacheApp({ cache, store, origin, ttlMs, clock });

  return { app, cache, store, origin };
}
