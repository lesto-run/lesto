import { randomBytes, scryptSync } from "node:crypto";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb } from "@keel/db";
import type { Db, SqlDatabase } from "@keel/db";
import { Migrator } from "@keel/migrate";

import {
  clearSessionCookie,
  createIdentity,
  IdentityError,
  normalizeEmail,
  readCookie,
  readSessionToken,
  SESSION_COOKIE,
  sessionCookie,
  users,
  usersMigration,
} from "../src/index";

import * as userRepo from "../src/user";

import type { Identity, IdentityMailer, IdentityOptions } from "../src/index";

// ---------------------------------------------------------------------------
// Test rig
//
// One in-memory SQLite per test, wrapped in @keel/db's `SqlDatabase` shape —
// the same handle satisfies both the ORM-shaped surface @keel/db consumes
// and the exec+prepare shape @keel/migrate runs DDL through. A clock we can
// step lets every TTL test be deterministic.
// ---------------------------------------------------------------------------

let raw: Database.Database;
let sql: SqlDatabase;
let db: Db;
let now: number;

const clock = (): number => now;
const advance = (ms: number): void => {
  now += ms;
};

function adapt(database: Database.Database): SqlDatabase {
  const adapted: SqlDatabase = {
    exec: async (statement) => {
      database.exec(statement);
    },
    prepare: (statement) => {
      const stmt = database.prepare(statement);

      return {
        run: async (params: unknown[] = []) => stmt.run(...(params as never[])),
        get: async (params: unknown[] = []) => stmt.get(...(params as never[])),
        all: async (params: unknown[] = []) => stmt.all(...(params as never[])),
      };
    },
    transaction: async (fn) => {
      database.exec("BEGIN");

      try {
        const out = await fn(adapted);
        database.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

interface CapturedEmail {
  to: string;
  url: string;
  token: string;
  kind: "verify" | "reset";
}

function captureMailer(): { mailer: IdentityMailer; sent: CapturedEmail[] } {
  const sent: CapturedEmail[] = [];

  return {
    sent,
    mailer: {
      sendVerificationEmail: (args) => {
        sent.push({ ...args, kind: "verify" });
      },
      sendPasswordResetEmail: (args) => {
        sent.push({ ...args, kind: "reset" });
      },
    },
  };
}

function buildIdentity(opts: Partial<IdentityOptions> = {}): {
  identity: Identity;
  sent: CapturedEmail[];
  revokedFor: string[];
} {
  const { mailer, sent } = captureMailer();
  const revokedFor: string[] = [];

  const identity = createIdentity({
    db,
    secret: "test-secret-0123456789abcdefghij",
    mailer,
    verificationUrl: (token) => `https://app.test/verify?token=${token}`,
    resetUrl: (token) => `https://app.test/reset?token=${token}`,
    revokeUserSessions: (userId) => {
      revokedFor.push(userId);
    },
    clock: () => clock(),
    ...opts,
  });

  return { identity, sent, revokedFor };
}

beforeEach(async () => {
  raw = new Database(":memory:");
  sql = adapt(raw);
  db = createDb(sql);
  now = new Date("2026-06-09T12:00:00Z").getTime();

  await new Migrator(sql, [usersMigration]).migrate();
});

afterEach(() => {
  raw.close();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// weak-secret guard (batched P1)
// ---------------------------------------------------------------------------

describe("weak-secret guard", () => {
  it("throws IDENTITY_WEAK_SECRET at construction for an empty secret", () => {
    try {
      buildIdentity({ secret: "" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IdentityError);
      expect((e as IdentityError).code).toBe("IDENTITY_WEAK_SECRET");
      expect((e as IdentityError).details).toMatchObject({ bytes: 0, minBytes: 32 });
    }
  });

  it("throws for a 31-byte secret (just under the boundary)", () => {
    expect(() => buildIdentity({ secret: "a".repeat(31) })).toThrowError(IdentityError);
  });

  it("accepts an exactly-32-byte secret (the boundary is inclusive)", () => {
    expect(() => buildIdentity({ secret: "a".repeat(32) })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

describe("register", () => {
  it("creates an unverified user and sends one verification email", async () => {
    const { identity, sent } = buildIdentity();

    const result = await identity.register("Ada@Example.com  ", "correct horse staple");

    expect(result.status).toBe("verification_sent");
    expect(result.user?.email).toBe("ada@example.com");
    expect(result.user?.emailVerifiedAt).toBeNull();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "verify", to: "ada@example.com" });
    expect(sent[0]?.url).toContain("https://app.test/verify?token=");
  });

  it("does not leak that an email is already registered", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "first password");
    sent.length = 0;

    // The second registration with the same email returns the SAME shape but
    // sends no email and does not produce a new user record.
    const result = await identity.register("ada@example.com", "another password");

    expect(result.status).toBe("verification_sent");
    expect(result.user).toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(await db.select().from(users).all()).toHaveLength(1);
  });

  it("rejects an obviously malformed email", async () => {
    const { identity } = buildIdentity();

    await expect(identity.register("not-an-email", "correct horse staple")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_EMAIL",
    });
  });

  it.each([
    ["comma-injected (next-auth CVE-2022-31102 class)", "ada@example.com,evil@attacker.com"],
    ["semicolon", "ada@example.com;evil"],
    ["angle brackets (HTML)", "<script>@example.com"],
    ["quotes (RFC 5321 quoted local part)", '"e@a.com"@v.com'],
    ["backslash (escape)", "ada\\@example.com"],
    ["parens (comment syntax)", "ada(ev)@example.com"],
    ["CR/LF (header injection)", "ada@example.com\r\nbcc:evil@x.com"],
  ])("rejects an email with %s", async (_label, email) => {
    const { identity } = buildIdentity();

    await expect(identity.register(email, "correct horse staple")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_EMAIL",
    });
  });

  it("rejects a password under the minimum length", async () => {
    const { identity } = buildIdentity();

    await expect(identity.register("ada@example.com", "short")).rejects.toMatchObject({
      code: "IDENTITY_WEAK_PASSWORD",
    });
  });

  it("rejects a password over the maximum length", async () => {
    const { identity } = buildIdentity();

    await expect(identity.register("ada@example.com", "x".repeat(129))).rejects.toMatchObject({
      code: "IDENTITY_WEAK_PASSWORD",
    });
  });
});

// ---------------------------------------------------------------------------
// verifyEmail
// ---------------------------------------------------------------------------

describe("verifyEmail", () => {
  it("flips email_verified_at on a valid token", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");

    const user = await identity.verifyEmail(sent[0]!.token);

    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.emailVerifiedAt).toMatch(/^2026-/);
  });

  it("is idempotent: a second verify on an already-verified user is a no-op", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    const first = await identity.verifyEmail(sent[0]!.token);
    const verifiedAt = first.emailVerifiedAt;

    advance(10_000);
    const second = await identity.verifyEmail(sent[0]!.token);

    expect(second.emailVerifiedAt).toBe(verifiedAt);
  });

  it("rejects a tampered or malformed token", async () => {
    const { identity } = buildIdentity();

    await expect(identity.verifyEmail("not-a-real-token")).rejects.toThrow(IdentityError);
    await expect(identity.verifyEmail("not-a-real-token")).rejects.toThrow(
      expect.objectContaining({ code: "IDENTITY_INVALID_TOKEN" }),
    );
  });

  it("rejects an expired token", async () => {
    const { identity, sent } = buildIdentity({ verificationTtlMs: 1000 });

    await identity.register("ada@example.com", "correct horse staple");
    advance(2000);

    await expect(identity.verifyEmail(sent[0]!.token)).rejects.toThrow(
      expect.objectContaining({ code: "IDENTITY_INVALID_TOKEN" }),
    );
  });

  it("rejects a token whose user has since been deleted", async () => {
    const { identity, sent } = buildIdentity();

    const { user } = await identity.register("ada@example.com", "correct horse staple");
    await userRepo.deleteUser(db, user!.id);

    await expect(identity.verifyEmail(sent[0]!.token)).rejects.toThrow(
      expect.objectContaining({ code: "IDENTITY_INVALID_TOKEN" }),
    );
  });

  it("rejects a token signed under a different purpose", async () => {
    // A token issued by the reset-password signer must not verify on the
    // verify-email path — that's the domain-separated-secret guarantee.
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.requestPasswordReset("ada@example.com");

    const resetEmail = sent.find((e) => e.kind === "reset")!;

    await expect(identity.verifyEmail(resetEmail.token)).rejects.toThrow(
      expect.objectContaining({ code: "IDENTITY_INVALID_TOKEN" }),
    );
  });
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

describe("login", () => {
  it("mints a session for verified credentials", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);

    const { user, session } = await identity.login("Ada@Example.com", "correct horse staple");

    expect(user.email).toBe("ada@example.com");
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);
    expect(session.expiresAt).toBeGreaterThan(clock());
  });

  it("returns IDENTITY_INVALID_CREDENTIALS for an unknown email", async () => {
    const { identity } = buildIdentity();

    await expect(identity.login("nobody@example.com", "whatever")).rejects.toThrow(
      expect.objectContaining({ code: "IDENTITY_INVALID_CREDENTIALS" }),
    );
  });

  it("returns IDENTITY_INVALID_CREDENTIALS for a wrong password", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);

    await expect(identity.login("ada@example.com", "wrong password")).rejects.toThrow(
      expect.objectContaining({ code: "IDENTITY_INVALID_CREDENTIALS" }),
    );
  });

  it("blocks an unverified email when requireVerifiedEmail is on", async () => {
    const { identity } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");

    await expect(identity.login("ada@example.com", "correct horse staple")).rejects.toThrow(
      expect.objectContaining({ code: "IDENTITY_EMAIL_NOT_VERIFIED" }),
    );
  });

  it("allows login without verification when the policy is off", async () => {
    const { identity } = buildIdentity({ requireVerifiedEmail: false });

    await identity.register("ada@example.com", "correct horse staple");

    const { session } = await identity.login("ada@example.com", "correct horse staple");

    expect(session.token).toBeDefined();
  });

  // Rehash-on-login: a user whose stored hash predates the current scrypt cost
  // logs in normally AND has the stored hash transparently upgraded.
  it("rehashes a stale (legacy-format) password hash on successful login", async () => {
    const { identity } = buildIdentity();
    const password = "correct horse staple";

    // Seed a user with a *legacy* parameterless hash (scrypt$salt$hash, N=2^14),
    // born verified — the pre-versioned shape that must keep working.
    const salt = randomBytes(16);
    const key = scryptSync(password, salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const legacyHash = `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;

    await userRepo.insertUser(db, {
      email: "ada@example.com",
      passwordHash: legacyHash,
      emailVerifiedAt: new Date().toISOString(),
    });

    const { user } = await identity.login("ada@example.com", password);

    // The login succeeded; the stored hash was upgraded to the current format.
    const stored = await userRepo.findUserById(db, user.id);
    expect(stored!.passwordHash).not.toBe(legacyHash);
    expect(stored!.passwordHash.startsWith(`scrypt$${2 ** 17}$8$1$`)).toBe(true);

    // The original password still logs in against the upgraded hash, and no
    // further rehash happens on the second login.
    const second = await identity.login("ada@example.com", password);
    const afterSecond = await userRepo.findUserById(db, second.user.id);
    expect(afterSecond!.passwordHash).toBe(stored!.passwordHash);
  });

  it("still logs in when the best-effort rehash persist fails", async () => {
    const { identity } = buildIdentity();
    const password = "correct horse staple";

    const salt = randomBytes(16);
    const key = scryptSync(password, salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const legacyHash = `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;

    await userRepo.insertUser(db, {
      email: "ada@example.com",
      passwordHash: legacyHash,
      emailVerifiedAt: new Date().toISOString(),
    });

    // The upgrade write fails — the login must succeed anyway (the proven
    // credentials are valid; only the cost upgrade is deferred).
    const spy = vi
      .spyOn(userRepo, "setPasswordHash")
      .mockRejectedValueOnce(new Error("write conflict"));

    const { session } = await identity.login("ada@example.com", password);

    expect(session).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);

    // The stored hash was left untouched — and a later login can retry the upgrade.
    const stored = await userRepo.findUserByEmail(db, "ada@example.com");
    expect(stored!.passwordHash).toBe(legacyHash);
  });

  it("does not rehash a current-cost hash on login", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);

    const before = (await userRepo.findUserByEmail(db, "ada@example.com"))!.passwordHash;
    await identity.login("ada@example.com", "correct horse staple");
    const after = (await userRepo.findUserByEmail(db, "ada@example.com"))!.passwordHash;

    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// requestPasswordReset
// ---------------------------------------------------------------------------

describe("requestPasswordReset", () => {
  it("sends a reset link to a known user", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    sent.length = 0;

    const result = await identity.requestPasswordReset("Ada@Example.com");

    expect(result.status).toBe("reset_sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "reset", to: "ada@example.com" });
  });

  it("returns success for an unknown email without sending mail", async () => {
    const { identity, sent } = buildIdentity();

    const result = await identity.requestPasswordReset("nobody@example.com");

    expect(result.status).toBe("reset_sent");
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resetPassword
// ---------------------------------------------------------------------------

describe("resetPassword", () => {
  it("changes the password and revokes the user's sessions", async () => {
    const { identity, sent, revokedFor } = buildIdentity();

    await identity.register("ada@example.com", "old password 1");
    await identity.verifyEmail(sent.find((e) => e.kind === "verify")!.token);
    await identity.requestPasswordReset("ada@example.com");

    const resetToken = sent.find((e) => e.kind === "reset")!.token;
    const user = await identity.resetPassword(resetToken, "brand new password");

    expect(user.email).toBe("ada@example.com");
    expect(revokedFor).toEqual([String(user.id)]);

    // The new password works; the old one does not.
    await expect(identity.login("ada@example.com", "old password 1")).rejects.toThrow(
      expect.objectContaining({ code: "IDENTITY_INVALID_CREDENTIALS" }),
    );
    expect(
      (await identity.login("ada@example.com", "brand new password")).session.token,
    ).toBeDefined();
  });

  it("works without a revokeUserSessions hook", async () => {
    const { mailer, sent } = captureMailer();
    const identity = createIdentity({
      db,
      secret: "secret-0123456789abcdefghijklmnop",
      mailer,
      verificationUrl: (t) => `https://app.test/v?t=${t}`,
      resetUrl: (t) => `https://app.test/r?t=${t}`,
      clock: () => clock(),
    });

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent.find((e) => e.kind === "verify")!.token);
    await identity.requestPasswordReset("ada@example.com");

    const user = await identity.resetPassword(
      sent.find((e) => e.kind === "reset")!.token,
      "new password ok",
    );

    expect(user.email).toBe("ada@example.com");
  });

  it("rejects a weak new password", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.requestPasswordReset("ada@example.com");

    const resetToken = sent.find((e) => e.kind === "reset")!.token;

    await expect(identity.resetPassword(resetToken, "short")).rejects.toMatchObject({
      code: "IDENTITY_WEAK_PASSWORD",
    });
  });

  it("rejects an invalid reset token", async () => {
    const { identity } = buildIdentity();

    await expect(identity.resetPassword("garbage", "new strong password")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOKEN",
    });
  });

  it("rejects a reset token whose user has since been deleted", async () => {
    const { identity, sent } = buildIdentity();

    const { user } = await identity.register("ada@example.com", "correct horse staple");
    await identity.requestPasswordReset("ada@example.com");
    const resetToken = sent.find((e) => e.kind === "reset")!.token;
    await userRepo.deleteUser(db, user!.id);

    await expect(identity.resetPassword(resetToken, "new strong password")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOKEN",
    });
  });

  // The single-use guarantee. The reset signer's secret incorporates the
  // user's current password_hash, so once the password changes the token's
  // HMAC stops verifying — even though the token itself is stateless.
  it("the same reset token cannot be used twice (single-use via password-hash binding)", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "first password ok");
    await identity.verifyEmail(sent.find((e) => e.kind === "verify")!.token);
    await identity.requestPasswordReset("ada@example.com");

    const resetToken = sent.find((e) => e.kind === "reset")!.token;

    // First reset succeeds; second reset with the SAME token must not.
    await identity.resetPassword(resetToken, "second password ok");

    await expect(identity.resetPassword(resetToken, "third password ok")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOKEN",
    });
  });

  it("rejects a reset token whose outer userId has been swapped", async () => {
    const { identity, sent } = buildIdentity();

    // Two users, two tokens; swap the outer userId so attacker hopes to
    // verify Bob's token against Ada's record.
    await identity.register("ada@example.com", "ada-strong-password");
    await identity.register("bob@example.com", "bob-strong-password");
    await identity.requestPasswordReset("ada@example.com");
    await identity.requestPasswordReset("bob@example.com");

    const adaToken = sent.find((e) => e.kind === "reset" && e.to === "ada@example.com")!.token;
    const bobToken = sent.find((e) => e.kind === "reset" && e.to === "bob@example.com")!.token;

    const [adaId] = adaToken.split(".", 1);
    const bobSigned = bobToken.slice(bobToken.indexOf(".") + 1);
    const swapped = `${adaId}.${bobSigned}`;

    await expect(identity.resetPassword(swapped, "attacker password")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOKEN",
    });
  });

  it.each([
    ["no separator", "no-separator-here"],
    ["leading separator", ".signedpart"],
    ["trailing separator", "1."],
  ])("rejects a malformed reset token: %s", async (_label, token) => {
    const { identity } = buildIdentity();

    await expect(identity.resetPassword(token, "new strong password")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOKEN",
    });
  });

  // A pre-check passes, then the INSERT races a parallel one and hits the
  // UNIQUE constraint on `email`. The handler must swallow it and present
  // the conflict shape — never a 500 to the client (which would betray the
  // collision via the status code).
  //
  // Identity imports `* as userRepo` precisely so the spy below reaches the
  // call site; with a named import the binding would be frozen and the spy
  // would never intercept.
  it("a UNIQUE-constraint race on insert is treated as a silent conflict", async () => {
    const { identity } = buildIdentity();

    await identity.register("race@example.com", "first password ok");

    // Stub the pre-check to lie once: it pretends no user exists, so the
    // INSERT runs into the existing row's UNIQUE constraint.
    const original = userRepo.findUserByEmail;
    const spy = vi
      .spyOn(userRepo, "findUserByEmail")
      .mockImplementationOnce(async (_db, email) =>
        email === "race@example.com" ? undefined : await original(_db, email),
      );

    const result = await identity.register("race@example.com", "second password ok");

    expect(result).toEqual({ status: "verification_sent", user: undefined });
    expect(spy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

describe("session lifecycle", () => {
  it("currentUser returns the live user for a valid session token", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    const { session } = await identity.login("ada@example.com", "correct horse staple");

    expect((await identity.currentUser(session.token))?.email).toBe("ada@example.com");
  });

  it("currentUser returns undefined for missing / unknown / expired tokens", async () => {
    const { identity, sent } = buildIdentity({ sessionTtlMs: 1000 });

    expect(await identity.currentUser(undefined)).toBeUndefined();
    expect(await identity.currentUser("not-a-session")).toBeUndefined();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    const { session } = await identity.login("ada@example.com", "correct horse staple");

    advance(2000);

    expect(await identity.currentUser(session.token)).toBeUndefined();
  });

  it("currentUser returns undefined when the session points at a deleted user", async () => {
    const { identity, sent } = buildIdentity();

    const { user } = await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    const { session } = await identity.login("ada@example.com", "correct horse staple");

    await userRepo.deleteUser(db, user!.id);

    expect(await identity.currentUser(session.token)).toBeUndefined();
  });

  it("logout revokes a session; undefined is a no-op", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    const { session } = await identity.login("ada@example.com", "correct horse staple");

    await identity.logout(undefined);
    expect((await identity.currentUser(session.token))?.email).toBe("ada@example.com");

    await identity.logout(session.token);
    expect(await identity.currentUser(session.token)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// User model + migration
// ---------------------------------------------------------------------------

describe("user model + migration", () => {
  it("normalizeEmail lower-cases and trims", () => {
    expect(normalizeEmail("  Ada@Example.com  ")).toBe("ada@example.com");
  });

  it("the migration's down drops the users table", async () => {
    const migrator = new Migrator(sql, [usersMigration]);

    expect(await migrator.rollback()).toBe(usersMigration.version);
    expect(() => raw.prepare("SELECT * FROM users").all()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

describe("cookie helpers", () => {
  it("the cookie name carries the __Host- prefix", () => {
    expect(SESSION_COOKIE).toBe("__Host-keel_session");
  });

  it("sessionCookie produces a __Host-compatible Set-Cookie string", () => {
    const header = sessionCookie("abc123");

    expect(header).toContain("__Host-keel_session=abc123");
    expect(header).toContain("Path=/");
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Domain=");
  });

  it("clearSessionCookie expires the cookie with Max-Age=0", () => {
    expect(clearSessionCookie()).toBe(
      "__Host-keel_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    );
  });

  it("readCookie pulls one named cookie out of a Cookie header", () => {
    const header = "foo=bar; __Host-keel_session=tok; other=baz";

    expect(readCookie(header, "__Host-keel_session")).toBe("tok");
    expect(readCookie(header, "foo")).toBe("bar");
    expect(readCookie(header, "missing")).toBeUndefined();
    expect(readCookie(undefined, "anything")).toBeUndefined();
  });

  it("readSessionToken finds the session cookie by name", () => {
    expect(readSessionToken("__Host-keel_session=abc; x=y")).toBe("abc");
    expect(readSessionToken(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Token signer (covers the no-clock branch of purposeTokens)
// ---------------------------------------------------------------------------

describe("token signer", () => {
  it("issues working tokens with the default system clock when none is injected", async () => {
    const { mailer, sent } = captureMailer();
    const identity = createIdentity({
      db,
      secret: "no-clock-test-0123456789abcdefghij",
      mailer,
      verificationUrl: (t) => `https://app/v?t=${t}`,
      resetUrl: (t) => `https://app/r?t=${t}`,
    });

    await identity.register("ada@example.com", "correct horse staple");
    const user = await identity.verifyEmail(sent[0]!.token);
    expect(user.emailVerifiedAt).not.toBeNull();

    // Drive the reset path too — exercises `resetSigner` with no clock for
    // both the unknown-user equalization branch and the real branch.
    await identity.requestPasswordReset("nobody@example.com");
    await identity.requestPasswordReset("ada@example.com");
    const resetToken = sent.find((e) => e.kind === "reset")!.token;
    await identity.resetPassword(resetToken, "fresh new password");

    expect(
      (await identity.login("ada@example.com", "fresh new password")).session.token,
    ).toBeDefined();
  });
});
