/**
 * @lesto/identity end-to-end, over a real socket.
 *
 * The unit tests pin every branch of `Identity` against an in-memory DB, but
 * none of them go through the wire — headers, cookies, the kernel boot order,
 * the response Set-Cookie surviving back to the client. This suite does.
 *
 * It drives the canonical journey the ADR pins as the integration target:
 *
 *     register → verify (via captured token) → login → access a gated route
 *              → reset → re-login
 *
 * The mailer is a *fake transport*: it captures the verification / reset link
 * the way the user would receive it in their inbox, so the test can follow it.
 * That mirrors how a deployment debugs an outbound-email problem.
 */

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "@lesto/kernel";
import type { LestoAppConfig, KernelDatabase } from "@lesto/kernel";
import { installSessionSchema, sqlSessionStore } from "@lesto/auth";
import { createDb } from "@lesto/db";
import { installRateLimitSchema, RateLimiter, sqlRateLimitStore } from "@lesto/ratelimit";
import { serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";
import { lesto } from "@lesto/web";
import type { Context, LestoResponse } from "@lesto/web";

import {
  clearSessionCookie,
  createIdentity,
  IdentityError,
  readSessionToken,
  sessionCookie,
  usersMigration,
} from "@lesto/identity";
import type { Identity, IdentityMailer } from "@lesto/identity";

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

interface CapturedLink {
  to: string;
  url: string;
  token: string;
  kind: "verify" | "reset";
}

const inbox: CapturedLink[] = [];

const mailer: IdentityMailer = {
  sendVerificationEmail(args) {
    inbox.push({ ...args, kind: "verify" });
  },
  sendPasswordResetEmail(args) {
    inbox.push({ ...args, kind: "reset" });
  },
};

let identity: Identity;

/** The auth body shape every credential handler reads off the request. */
function authBody(c: Context): { email: string; password: string; token?: string } {
  return c.req.body as { email: string; password: string; token?: string };
}

function errorResponse(error: unknown): LestoResponse {
  if (error instanceof IdentityError) {
    let status = 400;
    if (
      error.code === "IDENTITY_EMAIL_NOT_VERIFIED" ||
      error.code === "IDENTITY_INVALID_CREDENTIALS"
    ) {
      status = 401;
    } else if (error.code === "IDENTITY_LOGIN_THROTTLED") {
      status = 429;
    }

    return {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, code: error.code }),
    };
  }

  throw error;
}

function adapt(raw: Database.Database): KernelDatabase {
  const adapted: KernelDatabase = {
    exec: async (sql) => {
      raw.exec(sql);
    },
    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: async (params = []) => statement.run(...(params as never[])),
        get: async (params = []) => statement.get(...(params as never[])),
        all: async (params = []) => statement.all(...(params as never[])),
      };
    },
    transaction: async (fn) => {
      raw.exec("BEGIN");

      try {
        const out = await fn(adapted);
        raw.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

function buildConfig(database: Database.Database): LestoAppConfig {
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
      const token = c.query("token") ?? "";
      try {
        await identity.verifyEmail(token);

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
    .post("/auth/logout", async (c) => {
      await identity.logout(readSessionToken(c.header("cookie")));

      return {
        status: 200,
        headers: { "content-type": "application/json", "Set-Cookie": clearSessionCookie() },
        body: JSON.stringify({ ok: true }),
      };
    })
    .post("/auth/request-reset", async (c) => {
      await identity.requestPasswordReset(authBody(c).email);

      return c.json({ ok: true });
    })
    .post("/auth/reset", async (c) => {
      const body = authBody(c);
      try {
        await identity.resetPassword(body.token ?? "", body.password);

        return c.json({ ok: true });
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
    });

  return {
    db: adapt(database),
    app,
    migrations: [usersMigration],
  };
}

// ---------------------------------------------------------------------------
// fetch helper — pulls the cookie out of the first response, threads it on
// ---------------------------------------------------------------------------

let base: string;

async function post(
  path: string,
  body: Record<string, unknown>,
  cookie?: string,
): Promise<{ status: number; json: unknown; cookie: string | null }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    json: await response.json(),
    cookie: response.headers.get("set-cookie"),
  };
}

async function get(path: string, cookie?: string): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = cookie === undefined ? {} : { headers: { cookie } };
  const response = await fetch(`${base}${path}`, init);

  return { status: response.status, json: await response.json() };
}

/** The cookie *value* (just the token) parsed out of a Set-Cookie header. */
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
// Boot
// ---------------------------------------------------------------------------

let database: Database.Database;
let server: Server;

beforeAll(async () => {
  database = new Database(":memory:");

  // The kernel adapter and @lesto/db take the same `SqlDatabase` shape, so
  // one wrapper around the in-memory database satisfies both consumers.
  identity = createIdentity({
    db: createDb(adapt(database)),
    secret: "integration-test-secret-0123456789",
    mailer,
    verificationUrl: (token) => `https://app.test/auth/verify?token=${token}`,
    resetUrl: (token) => `https://app.test/auth/reset?token=${token}`,
  });

  server = await serve(await createApp(buildConfig(database)), { port: 0, logError: () => {} });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  database.close();
});

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

describe("the identity journey, over the wire", () => {
  it("register → verify → login → gated → reset → re-login", async () => {
    // ---- register ----
    inbox.length = 0;
    const registered = await post("/auth/register", {
      email: "Ada@example.com",
      password: "correct horse staple",
    });
    expect(registered.status).toBe(200);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: "verify", to: "ada@example.com" });

    // ---- login is rejected: email not verified ----
    const blocked = await post("/auth/login", {
      email: "ada@example.com",
      password: "correct horse staple",
    });
    expect(blocked.status).toBe(401);
    expect(blocked.json).toMatchObject({ ok: false, code: "IDENTITY_EMAIL_NOT_VERIFIED" });

    // ---- follow the captured verification link ----
    const verifyToken = inbox.find((e) => e.kind === "verify")!.token;
    const verified = await get(`/auth/verify?token=${encodeURIComponent(verifyToken)}`);
    expect(verified.status).toBe(200);

    // ---- login → server returns a Set-Cookie with our __Host- session ----
    const loggedIn = await post("/auth/login", {
      email: "ada@example.com",
      password: "correct horse staple",
    });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.cookie).toContain("__Host-lesto_session=");
    expect(loggedIn.cookie).toContain("HttpOnly");
    expect(loggedIn.cookie).toContain("Secure");
    expect(loggedIn.cookie).toContain("SameSite=Lax");

    const sessionToken = tokenFromSetCookie(loggedIn.cookie);

    // ---- /me without the cookie is 401; with it, the user comes through ----
    const guarded = await get("/me");
    expect(guarded.status).toBe(401);

    const me = await get("/me", cookieHeader(sessionToken));
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ ok: true, email: "ada@example.com" });

    // ---- request a reset; follow the link ----
    inbox.length = 0;
    const requestReset = await post("/auth/request-reset", { email: "ada@example.com" });
    expect(requestReset.status).toBe(200);
    expect(inbox.find((e) => e.kind === "reset")).toBeDefined();

    const resetToken = inbox.find((e) => e.kind === "reset")!.token;

    const reset = await post("/auth/reset", {
      token: resetToken,
      password: "fresh new password",
    });
    expect(reset.status).toBe(200);

    // ---- the old password is gone ----
    const oldPasswordRejected = await post("/auth/login", {
      email: "ada@example.com",
      password: "correct horse staple",
    });
    expect(oldPasswordRejected.status).toBe(401);
    expect(oldPasswordRejected.json).toMatchObject({ code: "IDENTITY_INVALID_CREDENTIALS" });

    // ---- the new password works; we ride a new session into /me ----
    const reLoggedIn = await post("/auth/login", {
      email: "ada@example.com",
      password: "fresh new password",
    });
    expect(reLoggedIn.status).toBe(200);

    const meAgain = await get("/me", cookieHeader(tokenFromSetCookie(reLoggedIn.cookie)));
    expect(meAgain.status).toBe(200);
    expect(meAgain.json).toMatchObject({ ok: true, email: "ada@example.com" });
  });

  it("does not leak that a colliding email is already registered", async () => {
    // Both responses must be shape-identical; the ADR's enumeration guarantee.
    inbox.length = 0;
    const first = await post("/auth/register", {
      email: "duplicate@example.com",
      password: "correct horse staple",
    });
    const second = await post("/auth/register", {
      email: "duplicate@example.com",
      password: "different password",
    });

    expect(first.status).toBe(second.status);
    expect(first.json).toEqual(second.json);
    // Only the first registration generated a verification email.
    expect(
      inbox.filter((e) => e.kind === "verify" && e.to === "duplicate@example.com"),
    ).toHaveLength(1);
  });

  it("logout clears the cookie and the session no longer resolves", async () => {
    inbox.length = 0;
    await post("/auth/register", { email: "logout@example.com", password: "correct horse staple" });
    await identity.verifyEmail(inbox.find((e) => e.to === "logout@example.com")!.token);

    const loggedIn = await post("/auth/login", {
      email: "logout@example.com",
      password: "correct horse staple",
    });
    const token = tokenFromSetCookie(loggedIn.cookie);

    expect((await get("/me", cookieHeader(token))).status).toBe(200);

    const loggedOut = await post("/auth/logout", {}, cookieHeader(token));
    expect(loggedOut.status).toBe(200);
    expect(loggedOut.cookie).toContain("__Host-lesto_session=;");
    expect(loggedOut.cookie).toContain("Max-Age=0");

    expect((await get("/me", cookieHeader(token))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Hardened journey: durable sessions + per-account throttle, over the wire.
//
// A second app/server, deliberately separate from the journey above so it can
// wire the *durable* posture (auth-security items 3 + 4) without disturbing the
// canonical flow: a SQL-backed session store (hashed at rest, revoke-on-reset
// by default) and a per-account login limiter over the SQL rate-limit store.
// `createApp({ db })` installs both schemas before the first request.
// ---------------------------------------------------------------------------

describe("the hardened identity journey, over the wire", () => {
  let hardenedDb: Database.Database;
  let hardenedServer: Server;
  let hardenedBase: string;
  let hardenedIdentity: Identity;
  const hardenedInbox: CapturedLink[] = [];

  const hardenedMailer: IdentityMailer = {
    sendVerificationEmail(args) {
      hardenedInbox.push({ ...args, kind: "verify" });
    },
    sendPasswordResetEmail(args) {
      hardenedInbox.push({ ...args, kind: "reset" });
    },
  };

  async function hPost(
    path: string,
    body: Record<string, unknown>,
    cookie?: string,
  ): Promise<{ status: number; json: unknown; cookie: string | null }> {
    const response = await fetch(`${hardenedBase}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    });

    return {
      status: response.status,
      json: await response.json(),
      cookie: response.headers.get("set-cookie"),
    };
  }

  async function hGet(path: string, cookie?: string): Promise<{ status: number; json: unknown }> {
    const init: RequestInit = cookie === undefined ? {} : { headers: { cookie } };
    const response = await fetch(`${hardenedBase}${path}`, init);

    return { status: response.status, json: await response.json() };
  }

  beforeAll(async () => {
    hardenedDb = new Database(":memory:");

    // The kernel adapter, @lesto/db, and both durable stores all take the same
    // SqlDatabase shape, so one wrapper around the in-memory DB satisfies all of
    // them — and the session store therefore shares the kernel-installed tables.
    const handle = adapt(hardenedDb);

    // The SQL stores prepare their statements eagerly at construction, so the
    // tables must exist before `createIdentity`. `createApp` would also install
    // them (idempotent), but it runs after the identity is built — so install up
    // front here too.
    await installSessionSchema(handle);
    await installRateLimitSchema(handle);

    hardenedIdentity = createIdentity({
      db: createDb(handle),
      secret: "hardened-integration-secret-0123456789",
      mailer: hardenedMailer,
      verificationUrl: (token) => `https://app.test/auth/verify?token=${token}`,
      resetUrl: (token) => `https://app.test/auth/reset?token=${token}`,
      // Item 3: durable sessions, hashed at rest, revoke-on-reset by default.
      sessionStore: sqlSessionStore(handle),
      // Item 4: a per-account login throttle over the SQL rate-limit store.
      // Small bucket, glacial refill — three failures lock the account within
      // the test window.
      loginRateLimiter: new RateLimiter({
        store: sqlRateLimitStore(handle),
        capacity: 3,
        refillPerSecond: 1 / 900,
      }),
    });

    // `identity` is the module-level handle the shared `buildConfig` routes read;
    // point it at the hardened service for this server's lifetime.
    identity = hardenedIdentity;

    hardenedServer = await serve(await createApp(buildConfig(hardenedDb)), {
      port: 0,
      logError: () => {},
    });
    hardenedBase = `http://127.0.0.1:${hardenedServer.port}`;
  });

  afterAll(async () => {
    await hardenedServer.close();
    hardenedDb.close();
  });

  it("compromised-account flow: a victim's reset ends an attacker's live session", async () => {
    hardenedInbox.length = 0;

    // The victim registers and verifies.
    await hPost("/auth/register", {
      email: "victim@example.com",
      password: "correct horse staple",
    });
    const verifyToken = hardenedInbox.find((e) => e.kind === "verify")!.token;
    await hGet(`/auth/verify?token=${encodeURIComponent(verifyToken)}`);

    // The ATTACKER has stolen the victim's credentials and logs in, riding a
    // real session cookie into the gated route.
    const attackerLogin = await hPost("/auth/login", {
      email: "victim@example.com",
      password: "correct horse staple",
    });
    expect(attackerLogin.status).toBe(200);
    const attackerToken = tokenFromSetCookie(attackerLogin.cookie);
    expect((await hGet("/me", cookieHeader(attackerToken))).status).toBe(200);

    // The victim notices, and resets their password.
    hardenedInbox.length = 0;
    await hPost("/auth/request-reset", { email: "victim@example.com" });
    const resetToken = hardenedInbox.find((e) => e.kind === "reset")!.token;
    const reset = await hPost("/auth/reset", { token: resetToken, password: "fresh new password" });
    expect(reset.status).toBe(200);

    // The attacker's previously-live session is now DEAD — revoke-on-reset by
    // default killed it via the SQL store's deleteByUserId. No bespoke wiring.
    expect((await hGet("/me", cookieHeader(attackerToken))).status).toBe(401);
  });

  it("a DB snapshot of the session row cannot be replayed as a live token", async () => {
    hardenedInbox.length = 0;

    await hPost("/auth/register", { email: "snap@example.com", password: "correct horse staple" });
    await hGet(
      `/auth/verify?token=${encodeURIComponent(
        hardenedInbox.find((e) => e.kind === "verify")!.token,
      )}`,
    );

    const loggedIn = await hPost("/auth/login", {
      email: "snap@example.com",
      password: "correct horse staple",
    });
    const liveToken = tokenFromSetCookie(loggedIn.cookie);

    // What an attacker would lift from a DB dump: the stored primary-key value.
    // It is a SHA-256 digest, never the plaintext token the client presents.
    const stored = hardenedDb.prepare("SELECT token FROM lesto_sessions").all() as Array<{
      token: string;
    }>;
    expect(stored).toHaveLength(1);
    const storedKey = stored[0]!.token;

    // The plaintext token is NOT what is at rest...
    expect(storedKey).not.toBe(liveToken);
    expect(storedKey).toMatch(/^[a-f0-9]{64}$/); // a sha256 hex digest

    // ...and presenting the stored digest as a cookie resolves to no session
    // (it hashes again and matches nothing). The snapshot is not replayable.
    expect((await hGet("/me", cookieHeader(storedKey))).status).toBe(401);

    // The real plaintext token still works — hashing stayed invisible to the user.
    expect((await hGet("/me", cookieHeader(liveToken))).status).toBe(200);
  });

  it("per-account throttle: N failed logins refuse with IDENTITY_LOGIN_THROTTLED", async () => {
    hardenedInbox.length = 0;

    await hPost("/auth/register", {
      email: "throttle@example.com",
      password: "correct horse staple",
    });
    await hGet(
      `/auth/verify?token=${encodeURIComponent(
        hardenedInbox.find((e) => e.kind === "verify")!.token,
      )}`,
    );

    // Three wrong-password attempts drain the 3-token bucket — each is a normal
    // 401 invalid-credentials.
    for (let i = 0; i < 3; i++) {
      const bad = await hPost("/auth/login", {
        email: "throttle@example.com",
        password: "wrong password",
      });
      expect(bad.status).toBe(401);
      expect(bad.json).toMatchObject({ code: "IDENTITY_INVALID_CREDENTIALS" });
    }

    // The next attempt — even with the CORRECT password — is throttled. The
    // account is locked, not the credential check.
    const throttled = await hPost("/auth/login", {
      email: "throttle@example.com",
      password: "correct horse staple",
    });
    expect(throttled.status).toBe(429);
    expect(throttled.json).toMatchObject({ code: "IDENTITY_LOGIN_THROTTLED" });
  });
});
