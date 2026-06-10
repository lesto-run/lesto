/**
 * @keel/identity end-to-end, over a real socket.
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

import { createApp } from "@keel/kernel";
import type { AppConfig, KernelDatabase } from "@keel/kernel";
import { createDb } from "@keel/db";
import { Router } from "@keel/router";
import { serve } from "@keel/runtime";
import type { Server } from "@keel/runtime";
import { Controller } from "@keel/web";
import type { ControllerClass, KeelResponse } from "@keel/web";

import {
  clearSessionCookie,
  createIdentity,
  IdentityError,
  readSessionToken,
  sessionCookie,
  usersMigration,
} from "@keel/identity";
import type { Identity, IdentityMailer } from "@keel/identity";

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

class AuthController extends Controller {
  async register(): Promise<KeelResponse> {
    const { email, password } = this.body();
    try {
      await identity.register(email, password);

      return this.json({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  }

  verify(): KeelResponse {
    const token = this.request.query["token"] ?? "";
    try {
      identity.verifyEmail(token);

      return this.json({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  }

  login(): KeelResponse {
    const { email, password } = this.body();
    try {
      const { session } = identity.login(email, password);

      return {
        status: 200,
        headers: { "content-type": "application/json", "Set-Cookie": sessionCookie(session.token) },
        body: JSON.stringify({ ok: true }),
      };
    } catch (error) {
      return errorResponse(error);
    }
  }

  logout(): KeelResponse {
    identity.logout(readSessionToken(this.request.headers["cookie"]));

    return {
      status: 200,
      headers: { "content-type": "application/json", "Set-Cookie": clearSessionCookie() },
      body: JSON.stringify({ ok: true }),
    };
  }

  async requestReset(): Promise<KeelResponse> {
    await identity.requestPasswordReset(this.body().email);

    return this.json({ ok: true });
  }

  async reset(): Promise<KeelResponse> {
    const body = this.body();
    try {
      await identity.resetPassword(body.token ?? "", body.password);

      return this.json({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private body(): { email: string; password: string; token?: string } {
    return this.request.body as { email: string; password: string; token?: string };
  }
}

class GatedController extends Controller {
  show(): KeelResponse {
    const user = identity.currentUser(readSessionToken(this.request.headers["cookie"]));

    if (!user) {
      return { status: 401, headers: { "content-type": "application/json" }, body: '{"ok":false}' };
    }

    return this.json({ ok: true, email: user.email });
  }
}

function errorResponse(error: unknown): KeelResponse {
  if (error instanceof IdentityError) {
    const status =
      error.code === "IDENTITY_EMAIL_NOT_VERIFIED" || error.code === "IDENTITY_INVALID_CREDENTIALS"
        ? 401
        : 400;

    return {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, code: error.code }),
    };
  }

  throw error;
}

function adapt(raw: Database.Database): KernelDatabase {
  return {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: (params = []) => statement.run(...(params as never[])),
        get: (params = []) => statement.get(...(params as never[])),
        all: (params = []) => statement.all(...(params as never[])),
      };
    },
  };
}

function buildConfig(database: Database.Database): AppConfig {
  const router = new Router()
    .post("/auth/register", "auth#register")
    .get("/auth/verify", "auth#verify")
    .post("/auth/login", "auth#login")
    .post("/auth/logout", "auth#logout")
    .post("/auth/request-reset", "auth#requestReset")
    .post("/auth/reset", "auth#reset")
    .get("/me", "gated#show");

  return {
    db: adapt(database),
    router,
    controllers: {
      auth: AuthController as ControllerClass,
      gated: GatedController as ControllerClass,
    },
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
  const match = /__Host-keel_session=([^;]+)/.exec(header!);
  expect(match).not.toBeNull();

  return match![1]!;
}

function cookieHeader(token: string): string {
  return `__Host-keel_session=${token}`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let database: Database.Database;
let server: Server;

beforeAll(async () => {
  database = new Database(":memory:");

  // The kernel's `useDatabase(config.db)` is for the legacy @keel/orm path;
  // @keel/identity now wants an explicit @keel/db handle over the same
  // underlying SQL surface. One adapter, two consumers.
  identity = createIdentity({
    db: createDb(adapt(database)),
    secret: "integration-test-secret",
    mailer,
    verificationUrl: (token) => `https://app.test/auth/verify?token=${token}`,
    resetUrl: (token) => `https://app.test/auth/reset?token=${token}`,
  });

  server = await serve(createApp(buildConfig(database)), { port: 0, logError: () => {} });
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
    expect(loggedIn.cookie).toContain("__Host-keel_session=");
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
    identity.verifyEmail(inbox.find((e) => e.to === "logout@example.com")!.token);

    const loggedIn = await post("/auth/login", {
      email: "logout@example.com",
      password: "correct horse staple",
    });
    const token = tokenFromSetCookie(loggedIn.cookie);

    expect((await get("/me", cookieHeader(token))).status).toBe(200);

    const loggedOut = await post("/auth/logout", {}, cookieHeader(token));
    expect(loggedOut.status).toBe(200);
    expect(loggedOut.cookie).toContain("__Host-keel_session=;");
    expect(loggedOut.cookie).toContain("Max-Age=0");

    expect((await get("/me", cookieHeader(token))).status).toBe(401);
  });
});
