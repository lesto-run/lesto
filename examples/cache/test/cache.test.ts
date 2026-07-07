/**
 * The example's QA gate: drive @lesto/cache's behaviors through the REAL HTTP
 * routes, the way a caller would, with a FROZEN clock so expiry is deterministic.
 *
 * These are the things only an end-to-end wiring can prove: that a repeat GET is
 * a hit (the origin never re-runs), that concurrent misses coalesce into one
 * origin call, that a mutation invalidates, that a TTL actually expires an entry,
 * that the SQL store persists a warm key across a restart, and that `sweep`
 * reclaims expired rows that were never re-read.
 */

import { describe, expect, it } from "vitest";

import { Cache, MemoryStore } from "@lesto/cache";
import { openSqlite } from "@lesto/runtime";

import { buildApp, createReportsOrigin, type Report } from "../src/app";

const TTL_MS = 60_000;

/** A mutable frozen clock: `now` is the value the cache reads for expiry. */
function frozenClock(): { clock: () => number; advance: (ms: number) => void } {
  let now = 1_000_000;

  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function boot(options: { advance?: (ms: number) => void; delayMs?: number } = {}) {
  const { db: handle, close } = await openSqlite();
  const time = frozenClock();

  const booted = await buildApp({
    handle,
    clock: time.clock,
    ttlMs: TTL_MS,
    ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
  });

  const getReport = async (id: string): Promise<Record<string, unknown>> => {
    const res = await booted.app.handle("GET", `/reports/${id}`);
    expect(res.status).toBe(200);

    return JSON.parse(res.body as string) as Record<string, unknown>;
  };

  return { ...booted, handle, time, getReport, close };
}

describe("@lesto/cache example — the read-through journey over HTTP", () => {
  it("reads through on a miss, then serves hits without touching the origin", async () => {
    const { origin, getReport, close } = await boot();

    try {
      const first = await getReport("alpha");
      expect(origin.loads).toBe(1);
      expect(first.value).toBe(500); // "alpha".length * 100

      // Two more reads inside the TTL: identical payloads, origin untouched.
      const second = await getReport("alpha");
      const third = await getReport("alpha");
      expect(origin.loads).toBe(1);
      expect(second.generatedAt).toBe(first.generatedAt);
      expect(third.generatedAt).toBe(first.generatedAt);
    } finally {
      close();
    }
  });

  it("coalesces concurrent misses for one key into a single origin call", async () => {
    // A slow origin opens the window for a herd to form; `remember` collapses it.
    const { origin, app, close } = await boot({ delayMs: 20 });

    try {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => app.handle("GET", "/reports/beta")),
      );

      const bodies = responses.map((r) => r.body as string);
      // Every joiner resolved with the leader's exact value...
      expect(new Set(bodies).size).toBe(1);
      // ...and the origin ran exactly once for the whole herd.
      expect(origin.loads).toBe(1);
    } finally {
      close();
    }
  });

  it("recomputes after an explicit invalidation", async () => {
    const { origin, app, getReport, close } = await boot();

    try {
      const before = await getReport("alpha");
      expect(origin.loads).toBe(1);

      const invalidated = await app.handle("POST", "/reports/alpha/invalidate");
      expect(invalidated.status).toBe(200);
      expect(JSON.parse(invalidated.body as string)).toMatchObject({ invalidated: true });

      const after = await getReport("alpha");
      // Recomputed: origin ran again and the fresh produce carries a new stamp.
      expect(origin.loads).toBe(2);
      expect(after.value).toBe(before.value);
      expect(after.generatedAt).toBe(before.generatedAt); // clock is frozen, so equal...
      // ...the recompute is proven by the origin count, not the stamp, when time
      // hasn't moved. (The TTL test below moves the clock to separate the stamps.)
    } finally {
      close();
    }
  });

  it("treats an entry past its TTL as a miss", async () => {
    const { origin, time, getReport, close } = await boot();

    try {
      const fresh = await getReport("alpha");
      expect(origin.loads).toBe(1);

      // Still live one tick before the deadline — a hit.
      time.advance(TTL_MS - 1);
      const stillWarm = await getReport("alpha");
      expect(origin.loads).toBe(1);
      expect(stillWarm.generatedAt).toBe(fresh.generatedAt);

      // Past the deadline — a miss; the origin re-runs and stamps a later time.
      time.advance(2);
      const expired = await getReport("alpha");
      expect(origin.loads).toBe(2);
      expect(expired.generatedAt).toBeGreaterThan(fresh.generatedAt as number);
    } finally {
      close();
    }
  });

  it("persists a warm key across a restart via the SQL store", async () => {
    const { app, handle, origin, getReport, close } = await boot();

    try {
      const warmed = await getReport("alpha");
      expect(origin.loads).toBe(1);

      // "Restart": a brand-new app + origin on the SAME database handle. Its own
      // origin has never run; a GET is served from the row the first app wrote.
      const restarted = await buildApp({
        handle,
        clock: () => warmed.generatedAt as number,
        ttlMs: TTL_MS,
      });
      const res = await restarted.app.handle("GET", "/reports/alpha");
      expect(res.status).toBe(200);

      const afterRestart = JSON.parse(res.body as string) as Record<string, unknown>;
      expect(afterRestart.generatedAt).toBe(warmed.generatedAt);
      expect(restarted.origin.loads).toBe(0); // never touched — served from SQL
      void app;
    } finally {
      close();
    }
  });

  it("sweeps expired rows that were never re-read", async () => {
    const { app, time, origin, getReport, close } = await boot();

    try {
      // Warm two keys, then let both deadlines pass WITHOUT re-reading them, so
      // read-eviction never fires and the rows linger — exactly sweep's job.
      await getReport("alpha");
      await getReport("beta");
      expect(origin.loads).toBe(2);

      time.advance(TTL_MS + 1);

      const swept = await app.handle("POST", "/cache/sweep");
      expect(swept.status).toBe(200);
      expect(JSON.parse(swept.body as string)).toMatchObject({ swept: 2 });

      // The rows are gone: the next read is a miss and recomputes.
      await getReport("alpha");
      expect(origin.loads).toBe(3);
    } finally {
      close();
    }
  });
});

describe("@lesto/cache example — the in-memory store, used directly", () => {
  it("reads through on a miss, serves a hit without the origin, and expires on TTL", async () => {
    // The other store @lesto/cache ships: a `MemoryStore` behind the same `Cache`
    // API, no SQLite. `origin.loads` is the hit/miss proof (frozen clock keeps the
    // stamp stable across a hit, so the count — not the stamp — proves the hit).
    const time = frozenClock();
    const origin = createReportsOrigin(time.clock);
    const cache = new Cache({ store: new MemoryStore(), clock: time.clock });
    const remember = (): Promise<Report> =>
      cache.remember("report:gamma", () => origin.load("gamma"), { ttlMs: TTL_MS });

    // Miss: the origin runs once and the value is cached.
    const first = await remember();
    expect(origin.loads).toBe(1);
    expect(first.value).toBe(500); // "gamma".length * 100

    // Hit inside the TTL: the origin is NOT touched and the stamp is stable.
    const warm = await remember();
    expect(origin.loads).toBe(1);
    expect(warm.generatedAt).toBe(first.generatedAt);

    // Past the TTL: a miss again — the origin re-runs with a later stamp.
    time.advance(TTL_MS + 1);
    const expired = await remember();
    expect(origin.loads).toBe(2);
    expect(expired.generatedAt).toBeGreaterThan(first.generatedAt);
  });
});
