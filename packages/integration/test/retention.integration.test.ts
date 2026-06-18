/**
 * Retention & sweeps, cross-driver (data-persistence item 11).
 *
 * Every durable store exposes a cheap delete-the-dead verb, and the
 * `RetentionScheduler` recipe wires them to a cadence in one place. The unit
 * suites prove each verb's logic against a fake; only a REAL engine proves they
 * execute the SQL correctly on both drivers — a partial index, a `< ?` deadline
 * comparison, a `finished_at` cutoff. This suite boots each store over a real
 * socket and sweeps it.
 *
 * The SQLite leg always runs (CI's integration step). The Postgres leg runs ONLY
 * when `LESTO_PG_URL` is set (the `db-parity-postgres` CI job, which has a Postgres
 * service) — so locally this is the SQLite leg alone. `dialect` is threaded into
 * every schema installer per driver, so the PG leg exercises the BIGINT epoch-ms
 * columns, the `GENERATED ALWAYS AS IDENTITY` queue key, AND the partial
 * `WHERE status = 'ready'` index that only the Postgres installer emits.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installCacheSchema, sqlStore } from "@lesto/cache";
import type { SqlCacheStore } from "@lesto/cache";
import { installSessionSchema, sqlSessionStore } from "@lesto/auth";
import { installRateLimitSchema, sqlRateLimitStore } from "@lesto/ratelimit";
import type { Dialect } from "@lesto/ratelimit";
import { installSchema as installQueueSchema, Queue, RetentionScheduler } from "@lesto/queue";
import type { SqlDatabase } from "@lesto/queue";
import { openSqlite } from "@lesto/runtime";

interface Driver {
  readonly name: Dialect;
  open(): Promise<{ db: SqlDatabase; close: () => unknown }>;
}

const PG_URL = process.env["LESTO_PG_URL"];

const drivers: Driver[] = [{ name: "sqlite", open: () => openSqlite() }];

if (PG_URL !== undefined) {
  drivers.push({
    name: "postgres",
    open: async () => {
      const { openPostgres } = await import("@lesto/pg");

      return openPostgres({ connectionString: PG_URL });
    },
  });
}

const MINUTE = 60_000;

describe.each(drivers)("retention & sweeps: $name", (driver) => {
  let handle: SqlDatabase;
  let close: () => unknown;
  // A stopped clock shared by the queue (Date) and the epoch-ms stores.
  let now: Date;
  const dateClock = (): Date => now;
  const epochClock = (): number => now.getTime();

  beforeEach(async () => {
    now = new Date("2026-06-16T12:00:00.000Z");

    const opened = await driver.open();
    handle = opened.db;
    close = opened.close;

    // Fresh schema each test — Postgres persists across tests in the CI service.
    await handle.exec("DROP TABLE IF EXISTS lesto_jobs");
    await handle.exec("DROP TABLE IF EXISTS lesto_cache");
    await handle.exec("DROP TABLE IF EXISTS lesto_sessions");
    await handle.exec("DROP TABLE IF EXISTS lesto_rate_limits");

    await installQueueSchema(handle, driver.name);
    await installCacheSchema(handle, driver.name);
    await installSessionSchema(handle);
    await installRateLimitSchema(handle);
  });

  afterEach(async () => {
    await close();
  });

  it("queue.prune deletes terminal jobs older than the window, sparing fresh and in-flight ones", async () => {
    const queue = new Queue({ db: handle, clock: dateClock, dialect: driver.name });
    queue.define("ok", () => {});
    queue.define("boom", () => {
      throw new Error("nope");
    });

    // An aged `done` and an aged `failed`, both finished "now".
    await queue.enqueue("ok");
    await queue.runOnce();
    await queue.enqueue("boom", {}, { maxAttempts: 1 });
    await queue.runOnce();

    // Jump forward, then a fresh `done` and an untouched `ready`.
    now = new Date(now.getTime() + 10 * MINUTE);
    await queue.enqueue("ok");
    await queue.runOnce();
    await queue.enqueue("ok"); // never run

    // Prune everything finished more than 5 minutes ago: only the two original
    // terminal rows; the fresh `done` (just finished) and the `ready` survive.
    expect(await queue.prune(5 * MINUTE)).toBe(2);

    const stats = await queue.stats();
    expect(stats.done).toBe(1);
    expect(stats.failed ?? 0).toBe(0);
    expect(stats.ready).toBe(1);
  });

  it("cache.sweep deletes only past-deadline rows, never NULL or future", async () => {
    const store: SqlCacheStore = sqlStore(handle);

    await store.set("expired", { value: "x", expiresAt: epochClock() - 1 });
    await store.set("future", { value: "y", expiresAt: epochClock() + MINUTE });
    await store.set("eternal", { value: "z", expiresAt: null });

    expect(await store.sweep(epochClock())).toBe(1);

    expect(await store.get("expired")).toBeUndefined();
    expect((await store.get("future"))?.value).toBe("y");
    expect((await store.get("eternal"))?.value).toBe("z");
  });

  it("session deleteExpired and rate-limit sweep run over a real engine", async () => {
    const sessions = sqlSessionStore(handle);
    await sessions.save({ token: "live", userId: "u1", expiresAt: epochClock() + MINUTE });
    await sessions.save({ token: "dead", userId: "u2", expiresAt: epochClock() - 1 });

    expect(await sessions.deleteExpired(epochClock())).toBe(1);
    expect(await sessions.find("live")).toBeDefined();
    expect(await sessions.find("dead")).toBeUndefined();

    const limits = sqlRateLimitStore(handle, { dialect: driver.name });
    await limits.update("k", () => ({ tokens: 5, updatedAt: epochClock() - MINUTE }));
    await limits.update("fresh", () => ({ tokens: 5, updatedAt: epochClock() }));

    // Sweep buckets last touched before now: the aged one goes, the fresh stays.
    expect(await limits.sweep(epochClock())).toBe(1);
  });

  it("the RetentionScheduler recipe drives every store's sweep from one tick", async () => {
    const queue = new Queue({ db: handle, clock: dateClock, dialect: driver.name });
    const cacheStore = sqlStore(handle);
    const sessions = sqlSessionStore(handle);
    const limits = sqlRateLimitStore(handle, { dialect: driver.name });

    // Seed one dead row in each store.
    queue.define("ok", () => {});
    await queue.enqueue("ok");
    await queue.runOnce(); // → done, finished now
    now = new Date(now.getTime() + 10 * MINUTE); // age it past the prune window
    await cacheStore.set("dead", { value: "x", expiresAt: epochClock() - 1 });
    await sessions.save({ token: "dead", userId: "u", expiresAt: epochClock() - 1 });
    await limits.update("dead", () => ({ tokens: 1, updatedAt: epochClock() - 20 * MINUTE }));

    // Wire the recipe: each store's verb is a task on its own cadence. `everyMs`
    // is 0 so all are due on the first tick.
    const scheduler = new RetentionScheduler({
      clock: epochClock,
      tasks: [
        { name: "queue", everyMs: 0, run: () => queue.prune(5 * MINUTE) },
        { name: "cache", everyMs: 0, run: (t) => cacheStore.sweep(t) },
        { name: "sessions", everyMs: 0, run: (t) => sessions.deleteExpired(t) },
        { name: "ratelimit", everyMs: 0, run: (t) => limits.sweep(t - 10 * MINUTE) },
      ],
    });

    const result = await scheduler.tick();

    // Four tasks ran; four dead rows deleted across the stores.
    expect(result.ran).toBe(4);
    expect(result.deleted).toBe(4);
    expect((await queue.stats()).done ?? 0).toBe(0);
    expect(await cacheStore.get("dead")).toBeUndefined();
    expect(await sessions.find("dead")).toBeUndefined();
  });
});
