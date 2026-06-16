/**
 * Kernel pit-of-success: `createApp({ db })` is durable by default (ADR 0013).
 *
 * The unit suites prove the wiring in isolation; only a real engine proves the
 * acceptance — that TWO independently-built app handles over ONE backing store
 * share sessions AND rate limits through SQL, with zero per-app store config.
 * That cross-handle sharing is exactly what a fleet does: two instances, one
 * database. A memory store cannot satisfy it; the SQL stores `createApp({ db })`
 * installs and `secureStack({ db })` / `durableStores(db)` wire do.
 *
 * The SQLite leg always runs (CI's integration step); the Postgres leg runs only
 * when `KEEL_PG_URL` is set, threading `dialect` so the PG `FOR UPDATE` path is
 * exercised. `:memory:` is unshareable across two opens, so both legs share ONE
 * opened handle between the two apps — the fleet shape, one socket.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashPassword } from "@keel/auth";
import { createDb } from "@keel/db";
import type { SqlDatabase } from "@keel/db";
import { Migrator } from "@keel/migrate";
import { openSqlite } from "@keel/runtime";

import { createApp, durableStores, installDurableSchema, secureStack } from "@keel/kernel";
import type { Dialect } from "@keel/ratelimit";
import { createIdentity, insertUser, usersMigration } from "@keel/identity";
import type { Identity } from "@keel/identity";
import { currentContext, fromRequestMiddleware, keel, runWithContext } from "@keel/web";
import type { KeelResponse } from "@keel/web";

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

const SECRET = "kernel-stores-secret-0123456789abc";

// Drive one GET inside a request context with a fixed client IP, as the runtime
// does, so every hit in a burst keys to the same SQL bucket; return the status.
const hit = (app: Awaited<ReturnType<typeof createApp>>): Promise<number> =>
  runWithContext({ requestId: "r", ip: "1.2.3.4" }, () => app.handle("GET", "/ping")).then(
    (r: KeelResponse) => r.status,
  );

describe.each(drivers)("createApp({ db }) durable by default: $name", (driver) => {
  let handle: SqlDatabase;
  let close: () => unknown;

  beforeEach(async () => {
    const opened = await driver.open();
    handle = opened.db;
    close = opened.close;

    // Fresh schema each test (Postgres persists across tests).
    await handle.exec("DROP TABLE IF EXISTS keel_sessions");
    await handle.exec("DROP TABLE IF EXISTS keel_rate_limits");
    await handle.exec("DROP TABLE IF EXISTS users");
    await handle.exec("DROP TABLE IF EXISTS schema_migrations");
  });

  afterEach(async () => {
    await close();
  });

  it("two app handles over one db share rate-limit buckets through SQL", async () => {
    // capacity 2, negligible refill: the bucket is shared, so the third request
    // across BOTH handles is throttled — proving the limit lives in SQL, not in
    // either process's memory.
    const policy = { capacity: 2, refillPerSecond: 0.000001 } as const;

    const buildHandle = async (): Promise<Awaited<ReturnType<typeof createApp>>> =>
      createApp({
        db: handle,
        dialect: driver.name,
        app: keel()
          .use(
            ...secureStack({ db: handle, dialect: driver.name, rateLimit: policy }).map(
              fromRequestMiddleware,
            ),
          )
          .get("/ping", (c) => c.json({ ip: currentContext()?.ip ?? null })),
      });

    const a = await buildHandle();
    const b = await buildHandle();

    // Spend the whole bucket on handle A.
    expect(await hit(a)).toBe(200);
    expect(await hit(a)).toBe(200);

    // Handle B — a separate app, a separate limiter — sees the SAME drained
    // bucket. Fleet-correct with zero per-app store config.
    expect(await hit(b)).toBe(429);
  });

  it("two identity layers over one db share sessions through SQL", async () => {
    // The session half: build the schema once (as createApp would after migrate),
    // seed a user, then wire TWO identities over the durable session store. A
    // login through one is a live session through the other; a logout through one
    // ends it for both — the row, not a process, is the truth.
    await new Migrator(handle, [usersMigration], { dialect: driver.name }).migrate();
    await installDurableSchema(handle);

    const db = createDb(handle, { dialect: driver.name });
    await insertUser(db, {
      email: "ada@example.com",
      passwordHash: await hashPassword("correct horse battery staple"),
      emailVerifiedAt: new Date().toISOString(),
    });

    const buildIdentity = async (): Promise<Identity> => {
      const { sessionStore } = await durableStores(handle, { dialect: driver.name });

      return createIdentity({
        db,
        sessionStore,
        secret: SECRET,
        mailer: { sendVerificationEmail: () => {}, sendPasswordResetEmail: () => {} },
        verificationUrl: (t) => `/verify?token=${t}`,
        resetUrl: (t) => `/reset?token=${t}`,
      });
    };

    const first = await buildIdentity();
    const second = await buildIdentity();

    const { session } = await first.login("ada@example.com", "correct horse battery staple");

    // The SECOND identity, over the same SQL store, resolves the session minted
    // by the first — sessions are shared, zero config.
    expect((await second.currentUser(session.token))?.email).toBe("ada@example.com");

    // A logout through the first ends it for the second too.
    await first.logout(session.token);
    expect(await second.currentUser(session.token)).toBeUndefined();
  });

  it("createApp installs both durable tables after migrate by default", async () => {
    await createApp({
      db: handle,
      dialect: driver.name,
      app: keel().get("/ping", (c) => c.text("pong")),
    });

    // Both ADR-0013 tables exist and accept a write — the zero-config default.
    const { sessionStore, rateLimitStore } = await durableStores(handle, { dialect: driver.name });

    await sessionStore.save({ token: "t", userId: "u", expiresAt: 9_999_999_999_999 });
    expect((await sessionStore.find("t"))?.userId).toBe("u");

    const bucket = await rateLimitStore.update("k", () => ({ tokens: 1, updatedAt: 1 }));
    expect(bucket).toEqual({ tokens: 1, updatedAt: 1 });
  });
});
