/**
 * The full Lesto app journey on a REAL database, asserting cross-process sharing.
 *
 * `db-parity` proves the query layer + schema installers on a networked Postgres,
 * and `kernel-stores` proves two in-process handles share sessions / rate limits.
 * Neither boots the whole app over the wire end-to-end. This suite does: it
 * `serve()`s a real Lesto app on `LESTO_PG_URL`, drives the canonical journey
 * through HTTP — register → verify (via the captured token) → login → a gated
 * route → a rate-limit check → enqueue a job → drain the worker to completion —
 * then stands up a SECOND, independently-built app over the SAME database and
 * proves the fleet contract: the second process resolves the session the first
 * minted, and a rate-limit bucket the first drained returns 429 on the second.
 *
 * That cross-process pair is exactly what a horizontally-scaled deploy needs and
 * exactly what a memory store cannot satisfy — only the durable SQL stores ADR
 * 0013 wires (over `durableStores` + `secureStack`) do. A SQLite-only assumption
 * anywhere in the identity / queue / cache / rate-limit wiring surfaces here.
 *
 * The SQLite leg always runs (the normal gate); the Postgres leg runs only when
 * `LESTO_PG_URL` is set — the `db-parity-postgres` CI job runs the whole integration
 * suite against a real Postgres, like the `durable-stores`/`kernel-stores` siblings.
 * It threads `dialect: "postgres"` so the PG `FOR UPDATE`/`FOR UPDATE SKIP LOCKED` paths are
 * exercised. `:memory:` is unshareable across two opens, so — like
 * `kernel-stores` — both app processes share ONE opened handle: the fleet shape,
 * one socket, serial (`fileParallelism: false`).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installCacheSchema, sqlStore } from "@lesto/cache";
import type { SqlDatabase } from "@lesto/db";
import { createDb } from "@lesto/db";
import { createApp, durableStores, installDurableSchema } from "@lesto/kernel";
import type { App, KernelDatabase } from "@lesto/kernel";
import {
  createIdentity,
  IdentityError,
  readSessionToken,
  sessionCookie,
  usersMigration,
} from "@lesto/identity";
import type { Identity, IdentityMailer } from "@lesto/identity";
import { installSchema as installQueueSchema, Queue } from "@lesto/queue";
import { RateLimiter, sqlRateLimitStore } from "@lesto/ratelimit";
import type { Dialect } from "@lesto/ratelimit";
import { openSqlite, serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";
import { lesto } from "@lesto/web";
import type { Context, LestoResponse } from "@lesto/web";

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

const SECRET = "full-app-pg-integration-secret-0123456789";

// A fixed key for the dedicated rate-limit route, so the bucket is deterministic
// and shared across both processes regardless of which socket made the request —
// the cross-process exhaustion under test, not the IP-derived kernel baseline.
const LIMIT_KEY = "full-app:shared-bucket";

/** The auth body shape every credential handler reads off the request. */
function authBody(c: Context): { email: string; password: string; token?: string } {
  return c.req.body as { email: string; password: string; token?: string };
}

function errorResponse(error: unknown): LestoResponse {
  if (error instanceof IdentityError) {
    const status =
      error.code === "IDENTITY_EMAIL_NOT_VERIFIED" || error.code === "IDENTITY_INVALID_CREDENTIALS"
        ? 401
        : error.code === "IDENTITY_LOGIN_THROTTLED"
          ? 429
          : 400;

    return {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, code: error.code }),
    };
  }

  throw error;
}

// ---------------------------------------------------------------------------
// A booted app process: the kernel App over a real socket, plus the identity,
// queue, and rate limiter wired over the SHARED handle. Two of these stood up
// over one `db` is the fleet — every store row is the single source of truth.
// ---------------------------------------------------------------------------

interface AppProcess {
  readonly base: string;
  readonly server: Server;
  readonly queue: Queue;
  /** The verification / reset links this process's mailer captured. */
  readonly inbox: Array<{ to: string; token: string; kind: "verify" | "reset" }>;
}

async function bootApp(handle: KernelDatabase, dialect: Dialect): Promise<AppProcess> {
  const inbox: AppProcess["inbox"] = [];

  const mailer: IdentityMailer = {
    sendVerificationEmail(args) {
      inbox.push({ to: args.to, token: args.token, kind: "verify" });
    },
    sendPasswordResetEmail(args) {
      inbox.push({ to: args.to, token: args.token, kind: "reset" });
    },
  };

  // The SQL stores prepare their statements eagerly at construction, so the
  // durable tables must exist before `durableStores`/`sqlRateLimitStore` are built
  // here — `createApp` would also install them (idempotent) but it runs after this
  // identity is wired. Install up front, exactly as the hardened identity journey does.
  await installDurableSchema(handle);

  // The session half rides the durable SQL store (shared across the fleet); the
  // rate-limit half is wired by the kernel's default `secure` over the same handle.
  const { sessionStore } = await durableStores(handle, { dialect });

  const identity: Identity = createIdentity({
    db: createDb(handle, { dialect }),
    sessionStore,
    secret: SECRET,
    mailer,
    verificationUrl: (token) => `https://app.test/auth/verify?token=${token}`,
    resetUrl: (token) => `https://app.test/auth/reset?token=${token}`,
  });

  // A dedicated limiter over the SHARED SQL bucket — capacity 2, glacial refill —
  // so the third check across BOTH processes is denied. This is the cross-process
  // assertion's instrument; it lives apart from the kernel's IP-keyed baseline
  // (capacity 100), which stays generous so the journey itself is never throttled.
  const limiter = new RateLimiter({
    store: sqlRateLimitStore(handle as Parameters<typeof sqlRateLimitStore>[0], { dialect }),
    capacity: 2,
    refillPerSecond: 0.000001,
  });

  // The queue handler is a trivial side effect proving cross-process atomicity:
  // a job enqueued through this process is claimed and run exactly once when the
  // worker drains, flipping the row to `done`.
  const processed: number[] = [];
  const queue = new Queue({ db: handle, dialect }).define<{ n: number }>("ping", (payload) => {
    processed.push(payload.n);
  });

  const app = lesto()
    .post("/auth/register", async (c) => {
      const { email, password } = authBody(c);
      try {
        await identity.register(email, password);

        return c.json({ ok: true });
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/auth/verify", async (c) => {
      try {
        await identity.verifyEmail(c.query("token") ?? "");

        return c.json({ ok: true });
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post("/auth/login", async (c) => {
      const { email, password } = authBody(c);
      try {
        const { session } = await identity.login(email, password);

        return {
          status: 200,
          headers: {
            "content-type": "application/json",
            "Set-Cookie": sessionCookie(session.token),
          },
          body: JSON.stringify({ ok: true }),
        };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/me", async (c) => {
      const user = await identity.currentUser(readSessionToken(c.header("cookie")));

      if (!user) {
        return {
          status: 401,
          headers: { "content-type": "application/json" },
          body: '{"ok":false}',
        };
      }

      return c.json({ ok: true, email: user.email });
    })
    .post("/limited", async (c) => {
      const { allowed } = await limiter.check(LIMIT_KEY);

      return c.json({ ok: allowed }, allowed ? 200 : 429);
    })
    .post("/jobs/ping", async (c) => {
      const { n } = c.req.body as { n: number };
      const id = await queue.enqueue("ping", { n });

      return c.json({ ok: true, id });
    })
    .post("/jobs/drain", async (c) => {
      // Drain the queue to completion: claim+run jobs until idle, so the test can
      // assert the enqueued job ran exactly once and the row is now `done`.
      let drained = 0;
      while ((await queue.runOnce()) !== null) {
        drained += 1;
      }

      return c.json({ ok: true, drained, processed });
    });

  const booted: App = await createApp({
    db: handle,
    dialect,
    app,
    migrations: [usersMigration],
    // The queue + cache batteries ride SQL tables of their own; declare their
    // installers so `lesto_jobs` / `lesto_cache` exist before the first enqueue/set.
    // (The durable session + rate-limit schemas install by default.)
    schemas: [(db) => installQueueSchema(db, dialect), (db) => installCacheSchema(db, dialect)],
  });

  const server = await serve(booted, { port: 0, logError: () => {} });

  return { base: `http://127.0.0.1:${server.port}`, server, queue, inbox };
}

// ---------------------------------------------------------------------------
// fetch helpers — thread the cookie the way a browser would
// ---------------------------------------------------------------------------

async function post(
  base: string,
  path: string,
  body: Record<string, unknown>,
  cookie?: string,
): Promise<{ status: number; json: unknown; cookie: string | null }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    json: await response.json(),
    cookie: response.headers.get("set-cookie"),
  };
}

async function get(
  base: string,
  path: string,
  cookie?: string,
): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = cookie === undefined ? {} : { headers: { cookie } };
  const response = await fetch(`${base}${path}`, init);

  return { status: response.status, json: await response.json() };
}

/** The cookie token parsed out of a Set-Cookie header. */
function tokenFromSetCookie(header: string | null): string {
  expect(header).not.toBeNull();
  const match = /__Host-lesto_session=([^;]+)/.exec(header!);
  expect(match).not.toBeNull();

  return match![1]!;
}

function cookieHeader(token: string): string {
  return `__Host-lesto_session=${token}`;
}

// ---------------------------------------------------------------------------
// The journey, per driver
// ---------------------------------------------------------------------------

describe.each(drivers)("full-app journey + cross-process sharing: $name", (driver) => {
  let handle: SqlDatabase;
  let close: () => unknown;
  let appA: AppProcess;
  let appB: AppProcess;

  beforeAll(async () => {
    const opened = await driver.open();
    handle = opened.db;
    close = opened.close;

    // Fresh schema (Postgres persists across runs); the two app boots below then
    // install everything against the clean database. Drop the queue's satellite
    // tables (`lesto_job_deps`, `lesto_job_batches`) BEFORE `lesto_jobs`: on the
    // shared PG db, dropping `lesto_jobs` alone resets its IDENTITY sequence while a
    // prior batch test's `lesto_job_deps` edge survives, so the next `enqueueBatch`
    // re-mints ids 1,2 and collides on the edge table's composite PK. No batch test
    // lives here yet, but mirror the fix so the first one added can't reintroduce
    // that pg-only collision. (No-op on SQLite.)
    for (const table of [
      "lesto_sessions",
      "lesto_rate_limits",
      "lesto_job_deps",
      "lesto_job_batches",
      "lesto_jobs",
      "lesto_cache",
      "users",
      "schema_migrations",
    ]) {
      await handle.exec(`DROP TABLE IF EXISTS ${table}`);
    }

    // TWO independently-built app processes over ONE database — the fleet. App A
    // migrates and installs; app B comes up against the already-migrated schema
    // (its own migrate is idempotent / a no-op), sharing every store row.
    appA = await bootApp(handle, driver.name);
    appB = await bootApp(handle, driver.name);
  });

  afterAll(async () => {
    await appA.server.close();
    await appB.server.close();
    await close();
  });

  it("register → verify → login → gated → rate-limit → enqueue → drain", async () => {
    const email = "ada@example.com";
    const password = "correct horse battery staple";

    // ---- register: a verification email is captured ----
    appA.inbox.length = 0;
    const registered = await post(appA.base, "/auth/register", { email, password });
    expect(registered.status).toBe(200);
    expect(appA.inbox).toHaveLength(1);
    expect(appA.inbox[0]).toMatchObject({ kind: "verify", to: email });

    // ---- login is refused until the email is verified ----
    const blocked = await post(appA.base, "/auth/login", { email, password });
    expect(blocked.status).toBe(401);
    expect(blocked.json).toMatchObject({ code: "IDENTITY_EMAIL_NOT_VERIFIED" });

    // ---- follow the captured link to verify ----
    const verifyToken = appA.inbox.find((e) => e.kind === "verify")!.token;
    const verified = await get(appA.base, `/auth/verify?token=${encodeURIComponent(verifyToken)}`);
    expect(verified.status).toBe(200);

    // ---- login: a durable __Host- session cookie comes back ----
    const loggedIn = await post(appA.base, "/auth/login", { email, password });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.cookie).toContain("__Host-lesto_session=");
    expect(loggedIn.cookie).toContain("HttpOnly");
    const token = tokenFromSetCookie(loggedIn.cookie);

    // ---- gated route: 401 without the cookie, the user through with it ----
    expect((await get(appA.base, "/me")).status).toBe(401);
    const me = await get(appA.base, "/me", cookieHeader(token));
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ ok: true, email });

    // ---- rate-limit check: the 2-token bucket allows two, denies the third ----
    expect((await post(appA.base, "/limited", {})).status).toBe(200);
    expect((await post(appA.base, "/limited", {})).status).toBe(200);
    const denied = await post(appA.base, "/limited", {});
    expect(denied.status).toBe(429);
    expect(denied.json).toMatchObject({ ok: false });

    // ---- enqueue a job, then drain the worker to complete it ----
    const enqueued = await post(appA.base, "/jobs/ping", { n: 7 });
    expect(enqueued.status).toBe(200);
    const jobId = (enqueued.json as { id: number }).id;
    expect(jobId).toBeGreaterThan(0);

    const drained = await post(appA.base, "/jobs/drain", {});
    expect(drained.status).toBe(200);
    expect(drained.json).toMatchObject({ ok: true, drained: 1, processed: [7] });

    // The job row is terminal (`done`) and never re-runs — a second drain is idle.
    const job = await appA.queue.find(jobId);
    expect(job?.status).toBe("done");
    expect((await post(appA.base, "/jobs/drain", {})).json).toMatchObject({ drained: 0 });

    // -------------------------------------------------------------------------
    // The fleet contract — a SECOND process over the SAME database.
    // -------------------------------------------------------------------------

    // 1) App B resolves the session App A minted: the session row, not a process,
    //    is the truth. A memory store would 401 here.
    const meOnB = await get(appB.base, "/me", cookieHeader(token));
    expect(meOnB.status).toBe(200);
    expect(meOnB.json).toMatchObject({ ok: true, email });

    // 2) The rate-limit bucket App A drained is empty for App B too: its first
    //    /limited hit is already 429 — the fleet throttles as one, zero per-app
    //    config. (Refill is glacial, so the bucket has not recovered.)
    const limitedOnB = await post(appB.base, "/limited", {});
    expect(limitedOnB.status).toBe(429);
    expect(limitedOnB.json).toMatchObject({ ok: false });
  });

  it("the durable cache round-trips a BIGINT epoch-ms deadline through the shared db", async () => {
    // The cache schema installed on boot is usable from either process over the
    // shared handle — proving the BIGINT `expires_at` survives a real PG socket
    // (it overflows int4), the same fix `db-parity` pins for the installer.
    const store = sqlStore(handle as Parameters<typeof sqlStore>[0]);
    await store.set("greeting", { value: { hi: "there" }, expiresAt: 1_750_000_000_000 });

    expect(await store.get("greeting")).toEqual({
      value: { hi: "there" },
      expiresAt: 1_750_000_000_000,
    });
  });
});
