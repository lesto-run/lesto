/**
 * Durable stores, cross-driver (ADR 0013). The package-local fakes prove the
 * stores' logic; only a real socket proves the *atomicity* claims, so this suite
 * boots `sqlSessionStore` and `sqlRateLimitStore` over a real engine.
 *
 * The SQLite leg always runs (in CI's integration step). The Postgres leg runs
 * ONLY when `LESTO_PG_URL` is set (the `db-parity-postgres` CI job, which has a
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

import { installSessionSchema, Sessions, sqlSessionStore, hashPassword } from "@lesto/auth";
import type { SqlDatabase as AuthSql } from "@lesto/auth";
import { installRateLimitSchema, RateLimiter, sqlRateLimitStore } from "@lesto/ratelimit";
import type { Dialect, SqlDatabase as RateLimitSql } from "@lesto/ratelimit";
import {
  createIdentity,
  findUserByEmail,
  insertUser,
  totpMigration,
  usersMigration,
} from "@lesto/identity";
import type { Identity } from "@lesto/identity";
import { createDb, createTableSql, defineTable, integer, text } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";
import type { MigrationEntry } from "@lesto/migrate";
import { installSchema as installQueueSchema, Queue } from "@lesto/queue";
import { openSqlite } from "@lesto/runtime";

import { dropQueueTables } from "./drop-queue-tables";

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

describe.each(drivers)("durable stores: $name", (driver) => {
  let handle: SqlDatabase;
  let close: () => unknown;

  beforeEach(async () => {
    const opened = await driver.open();
    handle = opened.db;
    close = opened.close;

    await handle.exec("DROP TABLE IF EXISTS lesto_sessions");
    await handle.exec("DROP TABLE IF EXISTS lesto_rate_limits");
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
      await new Migrator(handle, [usersMigration, totpMigration], {
        dialect: driver.name,
      }).migrate();
      await installSessionSchema(handle as AuthSql);

      db = createDb(handle, { dialect: driver.name });

      // Seed a pre-verified user directly (no email round-trip in the test).
      const now = new Date().toISOString();
      await insertUser(db, {
        email: "ada@example.com",
        passwordHash: await hashPassword("correct horse battery staple"),
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

      const login = await identity.login("ada@example.com", "correct horse battery staple");
      if (login.status !== "authenticated")
        throw new Error(`expected authenticated login, got ${login.status}`);
      const { session } = login;
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

    // Reset the queue's three tables before reinstalling a fresh schema (why the
    // whole trio, not just `lesto_jobs`, and why the shared-PG collision matters:
    // see `dropQueueTables`).
    await dropQueueTables(handle);
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

  it("stats() returns real numbers (Postgres COUNT(*) arrives as a string)", async () => {
    const queue = new Queue({ db: handle, dialect: driver.name });

    await queue.enqueue("work", { i: 1 });
    await queue.enqueue("work", { i: 2 });
    // Claim one so two statuses exist: one `running`, one `ready`.
    await queue.claim();

    const stats = await queue.stats();

    // The COUNT(*) coercion: node-postgres returns the aggregate as a STRING,
    // so without `Number(…)` these would be `"1"` and fail `typeof === "number"`.
    expect(typeof stats.running).toBe("number");
    expect(typeof stats.ready).toBe("number");
    expect(stats).toMatchObject({ running: 1, ready: 1 });
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

  it("a batch dependency releases on the prerequisite's completion — over a real socket", async () => {
    // The dependency-release `UPDATE` (run from `complete`) and the `blocked → ready`
    // flip only ever ran against the SQLite fake before; this proves the same
    // `NOT EXISTS (an unfinished prerequisite)` SQL flips a fan-in dependent on a
    // real Postgres connection too (where BIGINT ids arrive as strings, and the
    // claim path partitions over pooled connections).
    const queue = new Queue({ db: handle, dialect: driver.name });

    const { id, jobIds } = await queue.enqueueBatch("import", [
      { name: "ingest" },
      { name: "thumbnail", dependsOn: [0] },
    ]);

    // The dependent starts blocked — invisible to the claim.
    expect((await queue.find(jobIds[1]!))?.status).toBe("blocked");

    // Claim + complete the prerequisite; its `done` releases the dependent.
    const ingest = await queue.claim();
    expect(ingest?.id).toBe(jobIds[0]);
    await queue["complete"](ingest!);

    expect((await queue.find(jobIds[1]!))?.status).toBe("ready");
    await expect(queue.batch(id)).resolves.toMatchObject({ total: 2, state: "pending" });
  });

  it("cascade-discarding a prerequisite removes its blocked dependent atomically — over a real socket", async () => {
    // discard runs the forward cascade (delete the row, read its `blocked` dependents,
    // sweep edges, recurse) in ONE transaction on the pooled driver's PINNED connection.
    // On a pooled Postgres driver a cascade off a fresh connection would escape the
    // span; this proves the blocked dependent is cascade-discarded (not stranded
    // `blocked`, not released to run against missing input) and the now-empty batch
    // reports `pending`, not a false `completed`, on a real socket.
    const queue = new Queue({ db: handle, dialect: driver.name });

    const { id, jobIds } = await queue.enqueueBatch("import", [
      { name: "ingest" },
      { name: "thumbnail", dependsOn: [0] },
    ]);

    // Discard the prerequisite → its blocked dependent is cascade-discarded too.
    expect(await queue.discard(jobIds[0]!)).toBe(true);
    expect(await queue.find(jobIds[1]!)).toBeNull();

    // Both jobs gone → an all-discarded batch is truthfully `pending`.
    await expect(queue.batch(id)).resolves.toMatchObject({ total: 2, state: "pending" });
  });
});

// ---------------------------------------------------------------------------
// Migrator self-deadlock regression (Postgres only). The advisory-lock span pins
// ONE connection for the whole migrate run; the per-migration transactions must
// run FLAT on that pinned connection. If they instead opened fresh
// `this.db.transaction(...)` spans, a pool with `max: 1` would have its only
// connection already held by the lock — the inner checkout would wait forever.
// This proves a `max: 1` migration COMPLETES. It is guarded against hanging the
// suite by a short connectionTimeout AND a hard Promise.race deadline that fails
// loud rather than wedging the runner.
// ---------------------------------------------------------------------------

describe.runIf(PG_URL !== undefined)("migrator: max:1 pool does not self-deadlock", () => {
  const HARD_DEADLINE_MS = 5_000;

  const usersTable = defineTable("users", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
  });
  const postsTable = defineTable("posts", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
  });

  const m1: MigrationEntry = {
    version: "001_users",
    migration: { up: async (s) => s.execute(createTableSql(usersTable, s.dialect)) },
  };
  const m2: MigrationEntry = {
    version: "002_posts",
    migration: { up: async (s) => s.execute(createTableSql(postsTable, s.dialect)) },
  };

  it("runs two migrations to completion on a single-connection pool", async () => {
    const { openPostgres } = await import("@lesto/pg");

    // A pool with exactly ONE connection and a short connect timeout: if the fix
    // regressed, the per-migration checkout could not be satisfied and would
    // surface a connect timeout (loud) rather than hang the lock span forever.
    const { db, close } = await openPostgres({
      connectionString: PG_URL,
      max: 1,
      connectionTimeoutMillis: 2_000,
    } as Parameters<typeof openPostgres>[0]);

    try {
      await db.exec("DROP TABLE IF EXISTS posts");
      await db.exec("DROP TABLE IF EXISTS users");
      await db.exec("DROP TABLE IF EXISTS schema_migrations");

      const run = new Migrator(db, [m2, m1], { dialect: "postgres" }).migrate();

      // Hard deadline so a true deadlock fails the test loud instead of wedging
      // the whole suite on a single connection that never frees.
      const applied = await Promise.race([
        run,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("migrate() did not complete on a max:1 pool — self-deadlock")),
            HARD_DEADLINE_MS,
          );
        }),
      ]);

      expect(applied).toEqual(["001_users", "002_posts"]);
    } finally {
      await close();
    }
  });
});
