/**
 * Durable stores, cross-driver (ADR 0013). The package-local fakes prove the
 * stores' logic; only a real socket proves the *atomicity* claims, so this suite
 * boots `sqlSessionStore` and `sqlRateLimitStore` over a real engine.
 *
 * The SQLite leg always runs (in CI's integration step). The Postgres leg runs
 * ONLY when `KEEL_PG_URL` is set (the `db-parity-postgres` CI job, which has a
 * Postgres service) — so locally this is the SQLite leg alone, and the PG leg is
 * a no-op until a real socket is wired. `dialect` is threaded into
 * `sqlRateLimitStore` per driver so the PG leg exercises `FOR UPDATE`.
 *
 * `usersMigration` now runs through a dialect-aware `Migrator` per driver — its
 * `createTableSql(users, schema.dialect)` renders an identity column on Postgres
 * instead of the `AUTOINCREMENT` it used to reject. The hand-written per-dialect
 * `users` DDL workaround is gone; this is the first identity-shaped flow whose
 * own migration installs on a real Postgres socket.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installSessionSchema, Sessions, sqlSessionStore, hashPassword } from "@keel/auth";
import type { SqlDatabase as AuthSql } from "@keel/auth";
import { installRateLimitSchema, RateLimiter, sqlRateLimitStore } from "@keel/ratelimit";
import type { Dialect, SqlDatabase as RateLimitSql } from "@keel/ratelimit";
import { createIdentity, findUserByEmail, insertUser, usersMigration } from "@keel/identity";
import type { Identity } from "@keel/identity";
import { createDb } from "@keel/db";
import type { Db, SqlDatabase } from "@keel/db";
import { Migrator } from "@keel/migrate";
import { installSchema as installQueueSchema, Queue } from "@keel/queue";
import { openSqlite } from "@keel/runtime";

interface Driver {
  readonly name: Dialect;
  open(): Promise<{ db: SqlDatabase; close: () => unknown }>;
}

const PG_URL = process.env["KEEL_PG_URL"];

const drivers: Driver[] = [{ name: "sqlite", open: () => openSqlite() }];

if (PG_URL !== undefined) {
  drivers.push({
    name: "postgres",
    open: async () => {
      const { openPostgres } = await import("@keel/pg");

      return openPostgres({ connectionString: PG_URL });
    },
  });
}

describe.each(drivers)("durable stores: $name", (driver) => {
  let handle: SqlDatabase;
  let close: () => unknown;

  beforeEach(async () => {
    const opened = await driver.open();
    handle = opened.db;
    close = opened.close;

    await handle.exec("DROP TABLE IF EXISTS keel_sessions");
    await handle.exec("DROP TABLE IF EXISTS keel_rate_limits");
    await handle.exec("DROP TABLE IF EXISTS users");
    // The migrator's bookkeeping table — dropped too so the migration re-runs
    // against a fresh schema on Postgres (which persists across tests).
    await handle.exec("DROP TABLE IF EXISTS schema_migrations");
  });

  afterEach(async () => {
    await close();
  });

  describe("session durability", () => {
    it("install is idempotent; the row (not the process) is the truth", async () => {
      await installSessionSchema(handle as AuthSql);
      // A second install must not throw.
      await installSessionSchema(handle as AuthSql);

      let now = 1_000;
      const store = sqlSessionStore(handle as AuthSql);
      const sessions = new Sessions({ store, clock: () => now });

      const session = await sessions.create("u1", 60_000);
      expect(await sessions.verify(session.token)).toEqual(session);

      // A SECOND store over the SAME handle sees the same row — durability is the
      // row, not the in-process object.
      const reopened = new Sessions({
        store: sqlSessionStore(handle as AuthSql),
        clock: () => now,
      });
      expect(await reopened.verify(session.token)).toEqual(session);

      // Revoke through the first; the second sees it gone.
      await sessions.revoke(session.token);
      expect(await reopened.verify(session.token)).toBeUndefined();
    });

    it("expiry deletes the row; deleteByUserId and deleteExpired count correctly", async () => {
      await installSessionSchema(handle as AuthSql);
      let now = 1_000;
      const store = sqlSessionStore(handle as AuthSql);
      const sessions = new Sessions({ store, clock: () => now });

      const a = await sessions.create("u1", 60_000);
      now = 61_000;
      // Past expiry: verify returns undefined AND sweeps the row.
      expect(await sessions.verify(a.token)).toBeUndefined();
      expect(await store.find(a.token)).toBeUndefined();

      // deleteByUserId kills exactly that user's sessions.
      await store.save({ token: "s1", userId: "u2", expiresAt: 10_000 });
      await store.save({ token: "s2", userId: "u2", expiresAt: 20_000 });
      await store.save({ token: "s3", userId: "u3", expiresAt: 30_000 });
      expect(await store.deleteByUserId("u2")).toBe(2);
      expect(await store.find("s3")).not.toBeUndefined();

      // deleteExpired sweeps strictly-before rows: at 30_000, s3 (== 30_000) is
      // NOT swept (the predicate is strict `<`); at 30_001 it is.
      expect(await store.deleteExpired(30_000)).toBe(0);
      expect(await store.find("s3")).not.toBeUndefined();
      expect(await store.deleteExpired(30_001)).toBe(1);
      expect(await store.find("s3")).toBeUndefined();
    });
  });

  describe("identity journey over the SQL session store", () => {
    let identity: Identity;
    let db: Db;

    beforeEach(async () => {
      // The migration installs `users` for the driver's dialect — no hand-written
      // DDL — proving identity's own migration runs on a real Postgres.
      await new Migrator(handle, [usersMigration], { dialect: driver.name }).migrate();
      await installSessionSchema(handle as AuthSql);

      db = createDb(handle, { dialect: driver.name });

      // Seed a pre-verified user directly (no email round-trip in the test).
      const now = new Date().toISOString();
      await insertUser(db, {
        email: "ada@example.com",
        passwordHash: hashPassword("correct horse battery staple"),
        emailVerifiedAt: now,
      });

      identity = createIdentity({
        db,
        sessionStore: sqlSessionStore(handle as AuthSql),
        secret: "integration-secret-0123456789abcde",
        mailer: { sendVerificationEmail: () => {}, sendPasswordResetEmail: () => {} },
        verificationUrl: (t) => `/verify?token=${t}`,
        resetUrl: (t) => `/reset?token=${t}`,
      });
    });

    it("login → currentUser → logout → currentUser is undefined", async () => {
      expect(await findUserByEmail(db, "ada@example.com")).not.toBeUndefined();

      const { session } = await identity.login("ada@example.com", "correct horse battery staple");
      expect((await identity.currentUser(session.token))?.email).toBe("ada@example.com");

      await identity.logout(session.token);
      expect(await identity.currentUser(session.token)).toBeUndefined();
    });
  });

  describe("rate-limit atomicity", () => {
    it("THE ATOMICITY PROOF: 12 concurrent checks on one key — exactly 5 admitted", async () => {
      await installRateLimitSchema(handle as RateLimitSql);

      // Fixed clock so no refill happens mid-burst; capacity 5.
      const limiter = new RateLimiter({
        store: sqlRateLimitStore(handle as RateLimitSql, { dialect: driver.name }),
        capacity: 5,
        refillPerSecond: 1,
        clock: () => 1_000,
      });

      // 12 concurrent checks on ONE key. On PG this exercises FOR UPDATE + the
      // first-insert retry across pooled connections; on SQLite it exercises the
      // runtime's transaction queue (item 1). If this flakes, the design is wrong.
      const results = await Promise.all(
        Array.from({ length: 12 }, () => limiter.check("ip:1.2.3.4")),
      );

      const allowed = results.filter((r) => r.allowed).length;
      expect(allowed).toBe(5);
      expect(results.length - allowed).toBe(7);

      // Final state: the bucket is fully drained.
      const store = sqlRateLimitStore(handle as RateLimitSql, { dialect: driver.name });
      const final = await store.update("ip:1.2.3.4", (current) => current!);
      expect(final.tokens).toBe(0);
    });

    it("refills over an advancing clock; sweep clears a fully-refilled key", async () => {
      await installRateLimitSchema(handle as RateLimitSql);

      let now = 1_000;
      const store = sqlRateLimitStore(handle as RateLimitSql, { dialect: driver.name });
      const limiter = new RateLimiter({
        store,
        capacity: 2,
        refillPerSecond: 1,
        clock: () => now,
      });

      expect((await limiter.check("k")).allowed).toBe(true); // 2 -> 1
      expect((await limiter.check("k")).allowed).toBe(true); // 1 -> 0
      expect((await limiter.check("k")).allowed).toBe(false); // empty

      now += 1_000; // one token accrues
      expect((await limiter.check("k")).allowed).toBe(true);

      // Sweep a fully-refilled key: at now + capacity/rate*1000 the row is moot.
      now += 10_000;
      const swept = await store.sweep(now);
      expect(swept).toBe(1);

      // The next check sees a fresh, full bucket.
      const fresh = await limiter.check("k");
      expect(fresh).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    });
  });
});

// ---------------------------------------------------------------------------
// Queue concurrency (increment 2): the at-most-once claim under contention is
// the queue's hardest correctness claim, and only a real socket proves it. On
// Postgres the claim leans on `FOR UPDATE SKIP LOCKED`; on SQLite, the runtime's
// single-connection serialization. The atomicity proof mirrors the rate-limit
// one above: a burst of concurrent claimers must partition the jobs exactly.
// ---------------------------------------------------------------------------

describe.each(drivers)("queue concurrency: $name", (driver) => {
  let handle: SqlDatabase;
  let close: () => unknown;

  beforeEach(async () => {
    const opened = await driver.open();
    handle = opened.db;
    close = opened.close;

    await handle.exec("DROP TABLE IF EXISTS keel_jobs");
    await installQueueSchema(handle, driver.name);
  });

  afterEach(async () => {
    await close();
  });

  it("THE ATOMICITY PROOF: 12 concurrent workers, 12 jobs — each claimed exactly once", async () => {
    const queue = new Queue({ db: handle, dialect: driver.name });

    // 12 ready jobs.
    const ids = new Set<number>();
    for (let i = 0; i < 12; i += 1) {
      ids.add(await queue.enqueue("work", { i }));
    }

    // 12 workers race to claim concurrently. On PG this exercises FOR UPDATE SKIP
    // LOCKED across pooled connections; on SQLite, the serialized write path.
    const claimed = await Promise.all(Array.from({ length: 12 }, () => queue.claim()));

    const claimedIds = claimed.map((job) => job?.id).filter((id): id is number => id !== undefined);

    // Every job was claimed, and no id appears twice — the at-most-once invariant.
    expect(claimedIds.length).toBe(12);
    expect(new Set(claimedIds).size).toBe(12);
    expect(new Set(claimedIds)).toEqual(ids);
  });

  it("a stalled worker's terminal write never resurrects a job another worker re-owns", async () => {
    const queue = new Queue({ db: handle, dialect: driver.name });
    const id = await queue.enqueue("work", { n: 1 });

    // Worker A claims with a short lease.
    const a = await queue.claim("default", 1);
    expect(a?.id).toBe(id);

    // The lease lapses; reclaim frees the row; worker B re-claims with a fresh lock.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await queue.reclaim()).toBe(1);
    const b = await queue.claim("default", 30_000);
    expect(b?.id).toBe(id);
    expect(b?.lockedUntil).not.toBe(a?.lockedUntil);

    // A's late completion is fenced by its stale lock token: the row stays under B.
    await queue["complete"](a!);
    expect((await queue.find(id))?.status).toBe("running");

    // B completes against the current token — the one that lands.
    await queue["complete"](b!);
    expect((await queue.find(id))?.status).toBe("done");
  });
});
