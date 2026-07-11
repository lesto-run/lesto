import { randomBytes, scryptSync } from "node:crypto";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSessionSchema, sqlSessionStore } from "@lesto/auth";
import { createDb } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";
import { installRateLimitSchema, RateLimiter, sqlRateLimitStore } from "@lesto/ratelimit";

import {
  clearSessionCookie,
  createIdentity,
  identityMigrations,
  IdentityError,
  normalizeEmail,
  readCookie,
  readSessionToken,
  SESSION_COOKIE,
  sessionCookie,
  totpMigration,
  userRolesMigration,
  users,
  usersMigration,
} from "../src/index";

import * as userRepo from "../src/user";

import { expectAuthenticated } from "./authed";
import { cheapHasher } from "./cheap-hasher";

import type {
  Identity,
  IdentityEvent,
  IdentityMailer,
  IdentityOptions,
  PasswordHasher,
} from "../src/index";

// ---------------------------------------------------------------------------
// Test rig
//
// One in-memory SQLite per test, wrapped in @lesto/db's `SqlDatabase` shape —
// the same handle satisfies both the ORM-shaped surface @lesto/db consumes
// and the exec+prepare shape @lesto/migrate runs DDL through. A clock we can
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
    // Inject the cheap-cost hasher so the scrypt-bound register/login/reset paths
    // run in microseconds instead of ~150 ms/derive. Any test that needs the REAL
    // cost (the rehash-on-login pair) uses `buildRealIdentity` instead.
    hasher: cheapHasher,
    clock: () => clock(),
    ...opts,
  });

  return { identity, sent, revokedFor };
}

/**
 * An identity on the REAL `@lesto/auth` scrypt hasher (production cost + legacy-hash
 * parsing). Used by the tests that assert production `needsRehash` behavior — the
 * rehash-on-login pair (seed a legacy hash, assert the transparent upgrade) and the
 * no-rehash-on-current-cost test — a claim that is meaningless under the cheap
 * hasher, whose `needsRehash` is pinned `false`. Leaving `hasher` unset also
 * exercises the `options.hasher ?? productionHasher` default the rest of the suite
 * overrides.
 */
function buildRealIdentity(): { identity: Identity; sent: CapturedEmail[] } {
  const { mailer, sent } = captureMailer();

  const identity = createIdentity({
    db,
    secret: "test-secret-0123456789abcdefghij",
    mailer,
    verificationUrl: (token) => `https://app.test/verify?token=${token}`,
    resetUrl: (token) => `https://app.test/reset?token=${token}`,
    clock: () => clock(),
  });

  return { identity, sent };
}

beforeEach(async () => {
  raw = new Database(":memory:");
  sql = adapt(raw);
  db = createDb(sql);
  now = new Date("2026-06-09T12:00:00Z").getTime();

  // `login` now consults the TOTP factor table (the F2 second-factor gate), so
  // the rig installs the TOTP schema alongside the users one — the same set a
  // real identity install carries.
  await new Migrator(sql, [usersMigration, totpMigration]).migrate();
  // The durable-store tests (revoke-on-reset, login throttle) run over real SQL
  // tables on the same in-memory handle; install both schemas up front so any
  // test can opt into the SQL-backed stores.
  await installSessionSchema(sql);
  await installRateLimitSchema(sql);
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

  // The insert's catch exists ONLY to swallow the parallel-registration
  // UNIQUE-constraint race (see "a UNIQUE-constraint race on insert is treated
  // as a silent conflict" below) — but a bare `catch {}` swallowed EVERY error
  // the try produced, including `hasher.hashPassword`. When the edge PBKDF2 bug
  // made `hashPassword` throw, this masked it as a `verification_sent` SUCCESS
  // with no row inserted: a 200 with an empty users table and no diagnostic
  // (L-f6fbfce8). Assert the actual failure surfaces instead of the fake
  // success shape.
  it("rethrows a non-unique-violation failure instead of a fake success (L-f6fbfce8)", async () => {
    const boom = new Error("hasher unavailable — not a unique violation");
    const throwingHasher: PasswordHasher = {
      ...cheapHasher,
      hashPassword: async () => {
        throw boom;
      },
    };

    const { identity } = buildIdentity({ hasher: throwingHasher });

    // Exact-identity match (not a loose message/code pattern): the ORIGINAL
    // error must reach the caller unchanged, not a swallowed/replaced one.
    await expect(identity.register("nobody-yet@example.com", "correct horse staple")).rejects.toBe(
      boom,
    );

    // No row was left behind — the failure surfaced instead of silently
    // no-opping with an unusable, half-registered account.
    expect(await userRepo.findUserByEmail(db, "nobody-yet@example.com")).toBeUndefined();
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

    const { user, session } = expectAuthenticated(
      await identity.login("Ada@Example.com", "correct horse staple"),
    );

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

    const { session } = expectAuthenticated(
      await identity.login("ada@example.com", "correct horse staple"),
    );

    expect(session.token).toBeDefined();
  });

  // Rehash-on-login: a user whose stored hash predates the current scrypt cost
  // logs in normally AND has the stored hash transparently upgraded.
  it("rehashes a stale (legacy-format) password hash on successful login", async () => {
    const { identity } = buildRealIdentity();
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
    const { identity } = buildRealIdentity();
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

    const { session } = expectAuthenticated(await identity.login("ada@example.com", password));

    expect(session).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);

    // The stored hash was left untouched — and a later login can retry the upgrade.
    const stored = await userRepo.findUserByEmail(db, "ada@example.com");
    expect(stored!.passwordHash).toBe(legacyHash);
  });

  it("does not rehash a current-cost hash on login", async () => {
    // MUST use the real hasher: this asserts production `needsRehash` returns false
    // for a hash it just minted at the current cost, so login leaves it untouched.
    // Under the cheap hasher (`needsRehash: () => false`) the rehash branch is
    // structurally unreachable and this assertion could never fail — a vacuous test.
    const { identity, sent } = buildRealIdentity();

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
      expectAuthenticated(await identity.login("ada@example.com", "brand new password")).session
        .token,
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
      hasher: cheapHasher,
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
    const { session } = expectAuthenticated(
      await identity.login("ada@example.com", "correct horse staple"),
    );

    expect((await identity.currentUser(session.token))?.email).toBe("ada@example.com");
  });

  it("currentUser returns undefined for missing / unknown / expired tokens", async () => {
    const { identity, sent } = buildIdentity({ sessionTtlMs: 1000 });

    expect(await identity.currentUser(undefined)).toBeUndefined();
    expect(await identity.currentUser("not-a-session")).toBeUndefined();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    const { session } = expectAuthenticated(
      await identity.login("ada@example.com", "correct horse staple"),
    );

    advance(2000);

    expect(await identity.currentUser(session.token)).toBeUndefined();
  });

  it("currentUser returns undefined when the session points at a deleted user", async () => {
    const { identity, sent } = buildIdentity();

    const { user } = await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    const { session } = expectAuthenticated(
      await identity.login("ada@example.com", "correct horse staple"),
    );

    await userRepo.deleteUser(db, user!.id);

    expect(await identity.currentUser(session.token)).toBeUndefined();
  });

  it("logout revokes a session; undefined is a no-op", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    const { session } = expectAuthenticated(
      await identity.login("ada@example.com", "correct horse staple"),
    );

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
    // Self-contained on a fresh handle: the shared rig now applies both the users
    // and TOTP migrations, so rolling back the shared stack would pop the TOTP one
    // first. This isolates the users migration to assert its own `down`.
    const localRaw = new Database(":memory:");
    const localSql = adapt(localRaw);
    const migrator = new Migrator(localSql, [usersMigration]);
    await migrator.migrate();

    expect(await migrator.rollback()).toBe(usersMigration.version);
    expect(() => localRaw.prepare("SELECT * FROM users").all()).toThrow();

    localRaw.close();
  });

  // L-250c1cdf: `login()` reads confirmed-factor state from `totp_factors` on
  // EVERY call, so a deployment that installs only `usersMigration` is missing
  // a table `login` silently depends on. `identityMigrations` is the ordered,
  // "install these" bundle meant to make that impossible to forget — assert its
  // exact contents and order rather than just its length, so a future reorder
  // or omission fails loudly here.
  it("identityMigrations bundles users, totp, and user-roles migrations in order", () => {
    expect(identityMigrations).toEqual([usersMigration, totpMigration, userRolesMigration]);
  });

  // The behavioral proof the tautology above can't give: the bundle, handed
  // straight to a `Migrator` exactly as the docs tell a consumer to, installs
  // every table `login` depends on — so a full register → verify → login round
  // trip succeeds with NO "no such table" error. This also pins that
  // `identityMigrations` (a `readonly` array) is assignable to `Migrator` — the
  // one call the bundle exists to make must compile.
  it("identityMigrations, run through a Migrator, satisfies a full login round trip", async () => {
    const fullRaw = new Database(":memory:");
    const fullSql = adapt(fullRaw);

    await new Migrator(fullSql, identityMigrations).migrate();

    const { mailer, sent } = captureMailer();
    const identity = createIdentity({
      db: createDb(fullSql),
      secret: "test-secret-0123456789abcdefghij",
      mailer,
      verificationUrl: (token) => `https://app.test/verify?token=${token}`,
      resetUrl: (token) => `https://app.test/reset?token=${token}`,
      hasher: cheapHasher,
      clock: () => clock(),
    });

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent.find((e) => e.kind === "verify")!.token);

    const result = await identity.login("ada@example.com", "correct horse staple");

    // No confirmed factor → a real session, no missing-table error.
    expect(result.status).toBe("authenticated");
    expectAuthenticated(result);

    fullRaw.close();
  });

  // Documents the trap `identityMigrations` exists to prevent: a DB that only
  // ran `usersMigration` throws a RAW, uncoded driver error the moment `login`
  // consults the missing `totp_factors` table — not one of the coded
  // credential/verification/throttle `IdentityError`s. (Detecting this
  // driver-specific "missing table" shape robustly across sqlite/pg/D1 was
  // judged too fragile to convert into a coded error — see the identity.ts
  // `login` docstring and the PR notes; this test locks in the documented,
  // as-is behavior instead.)
  it("login throws a raw, uncoded error when totp_factors is missing (not installing totpMigration)", async () => {
    const bareRaw = new Database(":memory:");
    const bareSql = adapt(bareRaw);
    const bareDb = createDb(bareSql);

    // Deliberately incomplete: only the users table, mirroring the trap.
    await new Migrator(bareSql, [usersMigration]).migrate();

    const { mailer, sent } = captureMailer();
    const identity = createIdentity({
      db: bareDb,
      secret: "test-secret-0123456789abcdefghij",
      mailer,
      verificationUrl: (token) => `https://app.test/verify?token=${token}`,
      resetUrl: (token) => `https://app.test/reset?token=${token}`,
      hasher: cheapHasher,
      clock: () => clock(),
    });

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent.find((e) => e.kind === "verify")!.token);

    let caught: unknown;
    try {
      await identity.login("ada@example.com", "correct horse staple");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(IdentityError);
    expect((caught as Error).message).toMatch(/totp_factors/);

    bareRaw.close();
  });
});

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

describe("cookie helpers", () => {
  it("the cookie name carries the __Host- prefix", () => {
    expect(SESSION_COOKIE).toBe("__Host-lesto_session");
  });

  it("sessionCookie produces a __Host-compatible Set-Cookie string", () => {
    const header = sessionCookie("abc123");

    expect(header).toContain("__Host-lesto_session=abc123");
    expect(header).toContain("Path=/");
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Domain=");
  });

  it("clearSessionCookie expires the cookie with Max-Age=0", () => {
    expect(clearSessionCookie()).toBe(
      "__Host-lesto_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    );
  });

  it("readCookie pulls one named cookie out of a Cookie header", () => {
    const header = "foo=bar; __Host-lesto_session=tok; other=baz";

    expect(readCookie(header, "__Host-lesto_session")).toBe("tok");
    expect(readCookie(header, "foo")).toBe("bar");
    expect(readCookie(header, "missing")).toBeUndefined();
    expect(readCookie(undefined, "anything")).toBeUndefined();
  });

  it("readSessionToken finds the session cookie by name", () => {
    expect(readSessionToken("__Host-lesto_session=abc; x=y")).toBe("abc");
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
      hasher: cheapHasher,
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
      expectAuthenticated(await identity.login("ada@example.com", "fresh new password")).session
        .token,
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// revoke-on-reset by default (SQL-backed session store) — auth-security item 3
// ---------------------------------------------------------------------------

describe("revoke-on-reset (SQL-backed default)", () => {
  /** An identity whose sessions live in the real SQL store on the shared handle. */
  function sqlBackedIdentity(): { identity: Identity; sent: CapturedEmail[] } {
    const { mailer, sent } = captureMailer();
    const identity = createIdentity({
      db,
      secret: "test-secret-0123456789abcdefghij",
      mailer,
      verificationUrl: (token) => `https://app.test/verify?token=${token}`,
      resetUrl: (token) => `https://app.test/reset?token=${token}`,
      sessionStore: sqlSessionStore(sql),
      hasher: cheapHasher,
      clock: () => clock(),
    });

    return { identity, sent };
  }

  it("ends every live session for the user on reset — no hook wired", async () => {
    const { identity, sent } = sqlBackedIdentity();

    await identity.register("ada@example.com", "old password 1");
    await identity.verifyEmail(sent.find((e) => e.kind === "verify")!.token);

    // The attacker holds a live session minted before the reset.
    const { session: attacker } = expectAuthenticated(
      await identity.login("ada@example.com", "old password 1"),
    );
    expect((await identity.currentUser(attacker.token))?.email).toBe("ada@example.com");

    // The victim resets their password — the SQL store's deleteByUserId fires by
    // default (no revokeUserSessions hook), killing the attacker's session.
    await identity.requestPasswordReset("ada@example.com");
    const resetToken = sent.find((e) => e.kind === "reset")!.token;
    await identity.resetPassword(resetToken, "brand new password");

    expect(await identity.currentUser(attacker.token)).toBeUndefined();
  });

  it("runs the revokeUserSessions hook IN ADDITION to the store-backed revoke", async () => {
    const { mailer, sent } = captureMailer();
    const revokedFor: string[] = [];
    const identity = createIdentity({
      db,
      secret: "test-secret-0123456789abcdefghij",
      mailer,
      verificationUrl: (token) => `https://app.test/verify?token=${token}`,
      resetUrl: (token) => `https://app.test/reset?token=${token}`,
      sessionStore: sqlSessionStore(sql),
      revokeUserSessions: (userId) => {
        revokedFor.push(userId);
      },
      hasher: cheapHasher,
      clock: () => clock(),
    });

    await identity.register("ada@example.com", "old password 1");
    await identity.verifyEmail(sent.find((e) => e.kind === "verify")!.token);
    const { session: attacker } = expectAuthenticated(
      await identity.login("ada@example.com", "old password 1"),
    );

    await identity.requestPasswordReset("ada@example.com");
    const resetToken = sent.find((e) => e.kind === "reset")!.token;
    const user = await identity.resetPassword(resetToken, "brand new password");

    // Store-backed revoke killed the session AND the second-tier hook fired.
    expect(await identity.currentUser(attacker.token)).toBeUndefined();
    expect(revokedFor).toEqual([String(user.id)]);
  });
});

// ---------------------------------------------------------------------------
// login throttling (per-account, fleet-correct) — auth-security item 4
// ---------------------------------------------------------------------------

describe("login throttling", () => {
  /** A SQL-backed per-account limiter: `capacity` failed attempts, slow refill. */
  function loginLimiter(capacity: number, handle: SqlDatabase = sql): RateLimiter {
    return new RateLimiter({
      store: sqlRateLimitStore(handle),
      capacity,
      // ~1 token / 15 min: deterministic over the stepped clock (no refill in-test).
      refillPerSecond: 1 / 900,
      clock: () => clock(),
    });
  }

  function throttledIdentity(limiter: RateLimiter): { identity: Identity; sent: CapturedEmail[] } {
    const { mailer, sent } = captureMailer();
    const identity = createIdentity({
      db,
      secret: "test-secret-0123456789abcdefghij",
      mailer,
      verificationUrl: (token) => `https://app.test/verify?token=${token}`,
      resetUrl: (token) => `https://app.test/reset?token=${token}`,
      loginRateLimiter: limiter,
      hasher: cheapHasher,
      clock: () => clock(),
    });

    return { identity, sent };
  }

  it("refuses with IDENTITY_LOGIN_THROTTLED after the bucket is drained", async () => {
    const { identity, sent } = throttledIdentity(loginLimiter(3));

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);

    // Three wrong-password attempts drain the 3-token bucket.
    for (let i = 0; i < 3; i++) {
      await expect(identity.login("ada@example.com", "wrong password")).rejects.toMatchObject({
        code: "IDENTITY_INVALID_CREDENTIALS",
      });
    }

    // The fourth is throttled — refused BEFORE the credential check, with the
    // retry hint in the details.
    await expect(identity.login("ada@example.com", "wrong password")).rejects.toMatchObject({
      code: "IDENTITY_LOGIN_THROTTLED",
    });

    const throttled = await identity
      .login("ada@example.com", "correct horse staple")
      .catch((e: unknown) => e);
    expect((throttled as IdentityError).code).toBe("IDENTITY_LOGIN_THROTTLED");
    expect((throttled as IdentityError).details?.["retryAfterMs"]).toBeGreaterThan(0);
  });

  it("does not throttle on a successful login (a real user never locks themselves out)", async () => {
    const { identity, sent } = throttledIdentity(loginLimiter(3));

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);

    // Many successful logins spend nothing — the bucket stays full.
    for (let i = 0; i < 5; i++) {
      const { session } = expectAuthenticated(
        await identity.login("ada@example.com", "correct horse staple"),
      );
      expect(session.token).toBeDefined();
    }
  });

  it("throttles an UNKNOWN email exactly like a known one (no enumeration leak)", async () => {
    const { identity } = throttledIdentity(loginLimiter(2));

    // The key is login:<email> for every email, so an unknown account drains and
    // throttles on the same schedule — the throttle never betrays existence.
    for (let i = 0; i < 2; i++) {
      await expect(identity.login("ghost@example.com", "whatever")).rejects.toMatchObject({
        code: "IDENTITY_INVALID_CREDENTIALS",
      });
    }

    await expect(identity.login("ghost@example.com", "whatever")).rejects.toMatchObject({
      code: "IDENTITY_LOGIN_THROTTLED",
    });
  });

  it("is fleet-correct: failures throttle the account across two store handles", async () => {
    // Two separate sqlRateLimitStore handles over the SAME table — the two nodes
    // of a fleet. Failures on one count against the other; the cap is shared.
    const sql2 = adapt(raw);
    const nodeA = throttledIdentity(loginLimiter(2, sql));
    const nodeB = throttledIdentity(loginLimiter(2, sql2));

    await nodeA.identity.register("ada@example.com", "correct horse staple");
    await nodeA.identity.verifyEmail(nodeA.sent[0]!.token);

    // One failure on node A, one on node B — together they drain the 2-token cap.
    await expect(nodeA.identity.login("ada@example.com", "wrong")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_CREDENTIALS",
    });
    await expect(nodeB.identity.login("ada@example.com", "wrong")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_CREDENTIALS",
    });

    // The next attempt on EITHER node is throttled — the limit is fleet-wide.
    await expect(
      nodeB.identity.login("ada@example.com", "correct horse staple"),
    ).rejects.toMatchObject({ code: "IDENTITY_LOGIN_THROTTLED" });
  });

  it("an account-not-verified login is not penalized (correct password, no guess)", async () => {
    // The credentials are right; the user just hasn't verified. That is not a
    // guessing signal, so it must not burn the throttle bucket.
    const { identity } = throttledIdentity(loginLimiter(1));

    await identity.register("ada@example.com", "correct horse staple");

    for (let i = 0; i < 3; i++) {
      await expect(identity.login("ada@example.com", "correct horse staple")).rejects.toMatchObject(
        {
          code: "IDENTITY_EMAIL_NOT_VERIFIED",
        },
      );
    }
  });
});

// ---------------------------------------------------------------------------
// brute-force protection is ON BY DEFAULT (F8 / L-92479cc7)
//
// The login path must be attempt-capped OUT OF THE BOX — with no `loginRateLimiter`
// wired — so an app author cannot ship a brute-forceable sign-in by omission.
// These tests configure NO limiter and assert the built-in in-memory throttle
// fires. Against the pre-F8 code (unlimited by default) the capped attempt was
// still IDENTITY_INVALID_CREDENTIALS, so each is a real RED→GREEN regression, not
// a vacuous restatement of the opt-in tests above.
// ---------------------------------------------------------------------------

describe("default login throttle (secure by default, opt-out not opt-in)", () => {
  it("caps failed logins with NO limiter wired (the 6th is IDENTITY_LOGIN_THROTTLED)", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);

    // Five wrong guesses spend the default 5-token bucket — each a plain credential
    // failure (the frozen clock refills nothing mid-test).
    for (let i = 0; i < 5; i++) {
      await expect(identity.login("ada@example.com", "wrong password")).rejects.toMatchObject({
        code: "IDENTITY_INVALID_CREDENTIALS",
      });
    }

    // The sixth is throttled BEFORE the credential check — with NO limiter wired.
    // Pre-F8 this stayed IDENTITY_INVALID_CREDENTIALS forever.
    const throttled = await identity
      .login("ada@example.com", "wrong password")
      .catch((e: unknown) => e);
    expect((throttled as IdentityError).code).toBe("IDENTITY_LOGIN_THROTTLED");
    expect((throttled as IdentityError).details?.["retryAfterMs"]).toBeGreaterThan(0);

    // Even the CORRECT password is refused once the bucket drains — the gate sits
    // before verification, so a lucky guess cannot slip past the cap.
    await expect(identity.login("ada@example.com", "correct horse staple")).rejects.toMatchObject({
      code: "IDENTITY_LOGIN_THROTTLED",
    });
  });

  it("caps an UNKNOWN email by default too (no enumeration leak)", async () => {
    const { identity } = buildIdentity();

    // Keyed login:<email> for every email, so a never-registered account drains
    // and throttles on the same schedule — the default cap reveals no existence.
    for (let i = 0; i < 5; i++) {
      await expect(identity.login("ghost@example.com", "whatever")).rejects.toMatchObject({
        code: "IDENTITY_INVALID_CREDENTIALS",
      });
    }
    await expect(identity.login("ghost@example.com", "whatever")).rejects.toMatchObject({
      code: "IDENTITY_LOGIN_THROTTLED",
    });
  });

  it("never drains the default bucket on a successful login (no self-lockout)", async () => {
    const { identity, sent } = buildIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);

    // Well past the default cap of GOOD sign-ins — each spends nothing, so a real
    // user is never locked out by their own repeated logins.
    for (let i = 0; i < 8; i++) {
      expectAuthenticated(await identity.login("ada@example.com", "correct horse staple"));
    }
  });

  it("`loginRateLimiter: false` opts out of the default cap deliberately", async () => {
    const { identity } = buildIdentity({ loginRateLimiter: false });

    // Far past the default cap: with the throttle explicitly disabled every
    // attempt is a plain credential failure, never IDENTITY_LOGIN_THROTTLED.
    for (let i = 0; i < 8; i++) {
      await expect(identity.login("ghost@example.com", "whatever")).rejects.toMatchObject({
        code: "IDENTITY_INVALID_CREDENTIALS",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Edge over-promise warning (L-8244c703)
//
// The default brute-force limiter is IN-MEMORY: a real per-process floor on a
// long-lived Node server, but reset on every isolate recycle on Workers/edge, so
// "on by default" over-promises there. createIdentity warns ONCE at wiring time
// (not per login()) when a default limiter is relied on under workerd. isWorkerd()
// keys off `globalThis.navigator.userAgent`, so we stub a Cloudflare-Workers brand
// to drive the edge branch deterministically on Node and unstub afterward.
// ---------------------------------------------------------------------------

describe("default limiter edge over-promise warning", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Construct an identity with no throttle-relevant defaults overridden; the
  // console.warn spy is the unit under test, so we discard the returned service.
  function build(opts: Partial<IdentityOptions> = {}): void {
    createIdentity({
      db,
      secret: "test-secret-0123456789abcdefghij",
      mailer: captureMailer().mailer,
      verificationUrl: (token) => `https://app.test/verify?token=${token}`,
      resetUrl: (token) => `https://app.test/reset?token=${token}`,
      hasher: cheapHasher,
      clock: () => clock(),
      ...opts,
    });
  }

  it("warns once on workerd when the default (in-memory) limiter is relied on", () => {
    // A positive Cloudflare-Workers brand is authoritative for isWorkerd().
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    build(); // no limiter wired → the in-memory default

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/in-memory/i);
  });

  it("does NOT warn on workerd when BOTH limiters are wired explicitly", () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // A caller who wired durable limiters for both paths made their own choice —
    // nothing to nag. (Never checked here; we only assert the warn is silent.)
    const durable = new RateLimiter({
      store: sqlRateLimitStore(sql),
      capacity: 5,
      refillPerSecond: 1,
    });
    build({ loginRateLimiter: durable, totpRateLimiter: durable });

    expect(warn).not.toHaveBeenCalled();
  });

  it("does NOT warn off-edge, even on the default limiter (no spam on Node)", () => {
    // A recognized Node brand is authoritative-negative for isWorkerd().
    vi.stubGlobal("navigator", { userAgent: "Node.js/22.0.0" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    build(); // default limiter, but not on edge

    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// identity event seam (onEvent) — auth-security item 6
// ---------------------------------------------------------------------------

describe("onEvent seam", () => {
  /**
   * An identity over the SHARED SQL session store, with an event sink — so
   * revoke-on-reset (and thus `session_revoked`) actually fires by default.
   */
  function eventfulIdentity(extra: Partial<IdentityOptions> = {}): {
    identity: Identity;
    sent: CapturedEmail[];
    events: IdentityEvent[];
  } {
    const { mailer, sent } = captureMailer();
    const events: IdentityEvent[] = [];

    const identity = createIdentity({
      db,
      secret: "test-secret-0123456789abcdefghij",
      mailer,
      verificationUrl: (token) => `https://app.test/verify?token=${token}`,
      resetUrl: (token) => `https://app.test/reset?token=${token}`,
      sessionStore: sqlSessionStore(sql),
      onEvent: (event) => {
        events.push(event);
      },
      hasher: cheapHasher,
      clock: () => clock(),
      ...extra,
    });

    return { identity, sent, events };
  }

  it("emits email_verified with the userId on the real verification transition", async () => {
    const { identity, sent, events } = eventfulIdentity();

    const { user } = await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);

    expect(events).toEqual([{ type: "email_verified", userId: String(user!.id), at: clock() }]);
  });

  it("does NOT re-emit email_verified on an idempotent second verify", async () => {
    const { identity, sent, events } = eventfulIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    events.length = 0;

    advance(10_000);
    await identity.verifyEmail(sent[0]!.token);

    // The second verify is a no-op; no event re-announces a flip that didn't happen.
    expect(events).toEqual([]);
  });

  it("emits login_succeeded with the userId on a valid login", async () => {
    const { identity, sent, events } = eventfulIdentity();

    const { user } = await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    events.length = 0;

    await identity.login("ada@example.com", "correct horse staple");

    expect(events).toEqual([{ type: "login_succeeded", userId: String(user!.id), at: clock() }]);
  });

  it("emits login_failed (no userId) for a wrong password", async () => {
    const { identity, sent, events } = eventfulIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    events.length = 0;

    await expect(identity.login("ada@example.com", "wrong password")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_CREDENTIALS",
    });

    expect(events).toEqual([{ type: "login_failed", at: clock() }]);
    // The enumeration-safe posture: a failed login never names a subject.
    expect(events[0]).not.toHaveProperty("userId");
  });

  it("emits login_failed (no userId) for an unknown email", async () => {
    const { identity, events } = eventfulIdentity();

    await expect(identity.login("nobody@example.com", "whatever")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_CREDENTIALS",
    });

    expect(events).toEqual([{ type: "login_failed", at: clock() }]);
  });

  it("emits login_failed (no userId) when the per-account throttle refuses", async () => {
    const limiter = new RateLimiter({
      store: sqlRateLimitStore(sql),
      capacity: 1,
      refillPerSecond: 1 / 900,
      clock: () => clock(),
    });
    const { identity, sent, events } = eventfulIdentity({ loginRateLimiter: limiter });

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    events.length = 0;

    // First wrong attempt drains the 1-token bucket (a login_failed)...
    await expect(identity.login("ada@example.com", "wrong")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_CREDENTIALS",
    });
    // ...the next is refused by the throttle BEFORE the credential check — still
    // a login_failed, still subjectless.
    await expect(identity.login("ada@example.com", "wrong")).rejects.toMatchObject({
      code: "IDENTITY_LOGIN_THROTTLED",
    });

    expect(events).toEqual([
      { type: "login_failed", at: clock() },
      { type: "login_failed", at: clock() },
    ]);
  });

  it("does NOT emit login_failed for an unverified-email refusal (not a guess)", async () => {
    const { identity, events } = eventfulIdentity();

    await identity.register("ada@example.com", "correct horse staple");
    events.length = 0;

    await expect(identity.login("ada@example.com", "correct horse staple")).rejects.toMatchObject({
      code: "IDENTITY_EMAIL_NOT_VERIFIED",
    });

    // Correct password, just unverified — not a failed login attempt.
    expect(events).toEqual([]);
  });

  it("emits password_reset then session_revoked (in that order) on a SQL-backed reset", async () => {
    const { identity, sent, events } = eventfulIdentity();

    const { user } = await identity.register("ada@example.com", "old password 1");
    await identity.verifyEmail(sent.find((e) => e.kind === "verify")!.token);
    await identity.login("ada@example.com", "old password 1");
    await identity.requestPasswordReset("ada@example.com");
    events.length = 0;

    const resetToken = sent.find((e) => e.kind === "reset")!.token;
    await identity.resetPassword(resetToken, "brand new password");

    const userId = String(user!.id);
    expect(events).toEqual([
      { type: "password_reset", userId, at: clock() },
      { type: "session_revoked", userId, at: clock() },
    ]);
  });

  it("emits password_reset but NOT session_revoked on a memory store (nothing was revoked)", async () => {
    // No sessionStore override => the default MemorySessionStore, which has no
    // deleteByUserId, so the reset revokes nothing and announces nothing.
    const { mailer, sent } = captureMailer();
    const events: IdentityEvent[] = [];
    const identity = createIdentity({
      db,
      secret: "test-secret-0123456789abcdefghij",
      mailer,
      verificationUrl: (token) => `https://app.test/verify?token=${token}`,
      resetUrl: (token) => `https://app.test/reset?token=${token}`,
      onEvent: (event) => {
        events.push(event);
      },
      hasher: cheapHasher,
      clock: () => clock(),
    });

    const { user } = await identity.register("ada@example.com", "old password 1");
    await identity.verifyEmail(sent.find((e) => e.kind === "verify")!.token);
    await identity.requestPasswordReset("ada@example.com");
    events.length = 0;

    await identity.resetPassword(sent.find((e) => e.kind === "reset")!.token, "brand new password");

    expect(events).toEqual([{ type: "password_reset", userId: String(user!.id), at: clock() }]);
  });

  it("emits session_revoked with the session's userId on logout of a live session", async () => {
    const { identity, sent, events } = eventfulIdentity();

    const { user } = await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    const { session } = expectAuthenticated(
      await identity.login("ada@example.com", "correct horse staple"),
    );
    events.length = 0;

    await identity.logout(session.token);

    expect(events).toEqual([{ type: "session_revoked", userId: String(user!.id), at: clock() }]);
  });

  it("does NOT emit on logout of undefined, an unknown, or an expired token", async () => {
    const { identity, sent, events } = eventfulIdentity({ sessionTtlMs: 1000 });

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    const { session } = expectAuthenticated(
      await identity.login("ada@example.com", "correct horse staple"),
    );
    events.length = 0;

    // No token, then a token that names no session — neither ends anything.
    await identity.logout(undefined);
    await identity.logout("not-a-real-session-token");
    expect(events).toEqual([]);

    // An expired token resolves to no live session, so logout announces nothing.
    advance(2000);
    await identity.logout(session.token);
    expect(events).toEqual([]);
  });

  it("awaits an async onEvent sink (a flushed span is never dropped mid-write)", async () => {
    const order: string[] = [];
    const { mailer, sent } = captureMailer();
    const identity = createIdentity({
      db,
      secret: "test-secret-0123456789abcdefghij",
      mailer,
      verificationUrl: (token) => `https://app.test/verify?token=${token}`,
      resetUrl: (token) => `https://app.test/reset?token=${token}`,
      onEvent: async (event) => {
        await Promise.resolve();
        order.push(event.type);
      },
      hasher: cheapHasher,
      clock: () => clock(),
    });

    await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);

    // The async sink ran to completion before verifyEmail resolved.
    expect(order).toEqual(["email_verified"]);
  });

  it("never emits anything when no onEvent hook is wired (the seam is opt-in)", async () => {
    // The default buildIdentity wires no onEvent; the whole journey must run with
    // the emit short-circuit (options.onEvent === undefined) taken every time.
    const { identity, sent } = buildIdentity({ sessionStore: sqlSessionStore(sql) });

    const { user } = await identity.register("ada@example.com", "correct horse staple");
    await identity.verifyEmail(sent[0]!.token);
    const { session } = expectAuthenticated(
      await identity.login("ada@example.com", "correct horse staple"),
    );
    await identity.logout(session.token);
    await identity.requestPasswordReset("ada@example.com");
    await identity.resetPassword(sent.find((e) => e.kind === "reset")!.token, "brand new password");

    // No throw, no sink — proves the no-hook path of `emit` is reachable.
    expect(user!.email).toBe("ada@example.com");
  });

  it("payloads are grep-clean of tokens, passwords, and cleartext emails", async () => {
    const { identity, sent, events } = eventfulIdentity({
      loginRateLimiter: new RateLimiter({
        store: sqlRateLimitStore(sql),
        capacity: 5,
        refillPerSecond: 1 / 900,
        clock: () => clock(),
      }),
    });

    // Drive EVERY event variant: email_verified, login_succeeded, login_failed,
    // password_reset, session_revoked.
    const password = "correct horse staple";
    await identity.register("ada@example.com", password);
    await identity.verifyEmail(sent.find((e) => e.kind === "verify")!.token);
    const { session } = expectAuthenticated(await identity.login("ada@example.com", password));
    await identity.logout(session.token);
    await identity.login("ada@example.com", "wrong password").catch(() => undefined);
    await identity.requestPasswordReset("ada@example.com");
    await identity.resetPassword(sent.find((e) => e.kind === "reset")!.token, "brand new password");

    // We saw all five distinct types.
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set([
        "email_verified",
        "login_succeeded",
        "session_revoked",
        "login_failed",
        "password_reset",
      ]),
    );

    // The whole event stream, serialized, must contain no secret material: no
    // password, no email address, and none of the issued tokens.
    const blob = JSON.stringify(events);

    expect(blob).not.toContain(password);
    expect(blob).not.toContain("brand new password");
    expect(blob).not.toContain("ada@example.com");
    expect(blob).not.toContain("ada"); // not even the local-part fragment
    for (const email of sent) {
      expect(blob).not.toContain(email.token);
    }
    expect(blob).not.toContain(session.token);
  });
});
