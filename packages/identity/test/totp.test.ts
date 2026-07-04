import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSessionSchema, sqlSessionStore, totpCode } from "@lesto/auth";
import { createDb, eq } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";
import { installRateLimitSchema, RateLimiter, sqlRateLimitStore } from "@lesto/ratelimit";

import { createIdentity, IdentityError, totpMigration } from "../src/index";
import { markRecoveryCodeUsed } from "../src/totp";
import { recoveryCodes as recoveryCodesTable, totpFactors } from "../src/totp";
// Namespace import so a test can `vi.spyOn` the conditional-claim helper to force
// the lost-race branch (a code unused at find-time but 0-row at the UPDATE).
import * as totpRepo from "../src/totp";
import { usersMigration } from "../src/user";

import { cheapHasher } from "./cheap-hasher";

import type { Identity, IdentityMailer, IdentityOptions } from "../src/index";

// ---------------------------------------------------------------------------
// Test rig — one in-memory SQLite per test, the @lesto/db `SqlDatabase` shape,
// and a clock we can step so TOTP windows are deterministic. Mirrors the rig in
// identity.test.ts; kept local so the TOTP suite owns its own schema set.
// ---------------------------------------------------------------------------

let raw: Database.Database;
let sql: SqlDatabase;
let db: Db;
let now: number;

const clock = (): number => now;

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

const noopMailer: IdentityMailer = {
  sendVerificationEmail: () => {},
  sendPasswordResetEmail: () => {},
};

function buildIdentity(opts: Partial<IdentityOptions> = {}): Identity {
  return createIdentity({
    db,
    secret: "test-secret-0123456789abcdefghij",
    mailer: noopMailer,
    verificationUrl: (token) => `https://app.test/verify?token=${token}`,
    resetUrl: (token) => `https://app.test/reset?token=${token}`,
    sessionStore: sqlSessionStore(sql),
    requireVerifiedEmail: false,
    appName: "Lesto Test",
    // Cheap-cost scrypt so the TOTP-confirm path (ten recovery-code digests) and the
    // register/login setup run in microseconds, not ~1.5 s of full-cost hashing.
    hasher: cheapHasher,
    clock: () => clock(),
    ...opts,
  });
}

/** Register + log in a fresh user, returning their id and a live session token. */
async function signedInUser(
  identity: Identity,
  email = "ada@example.com",
  password = "correct horse staple",
): Promise<{ userId: number; token: string }> {
  const { user } = await identity.register(email, password);

  const { user: loggedIn, session } = await identity.login(email, password);

  return { userId: user?.id ?? loggedIn.id, token: session.token };
}

/** The live TOTP code for a secret at the test clock. */
function codeFor(secret: string): string {
  return totpCode(secret, { clock: () => clock() })!;
}

beforeEach(async () => {
  raw = new Database(":memory:");
  sql = adapt(raw);
  db = createDb(sql);
  now = new Date("2026-06-18T12:00:00Z").getTime();

  await new Migrator(sql, [usersMigration, totpMigration]).migrate();
  await installSessionSchema(sql);
  await installRateLimitSchema(sql);
});

/** A SQL-backed per-account TOTP limiter: `capacity` failed attempts, slow refill. */
function totpLimiter(capacity: number): RateLimiter {
  return new RateLimiter({
    store: sqlRateLimitStore(sql),
    capacity,
    // ~1 token / 15 min: deterministic over the stepped clock (no refill in-test).
    refillPerSecond: 1 / 900,
    clock: () => clock(),
  });
}

afterEach(() => {
  raw.close();
});

// ---------------------------------------------------------------------------
// The end-to-end TOTP journey: enroll → confirm → challenge-verify (+ recovery)
// ---------------------------------------------------------------------------

describe("TOTP journey", () => {
  it("enrolls, confirms with the first code, then verifies a challenge", async () => {
    const identity = buildIdentity();
    const { userId, token } = await signedInUser(identity);

    // Before enrollment, the MFA-gate probe is false.
    expect(await identity.hasTotp(userId)).toBe(false);

    // 1. Enroll: returns the secret + an otpauth:// provisioning URI, stores an
    //    UNCONFIRMED factor — so `hasTotp` is still false.
    const { secret, keyUri } = await identity.enrollTotp(token);

    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(keyUri).toContain("otpauth://totp/Lesto%20Test:ada%40example.com");
    expect(keyUri).toContain(`secret=${secret}`);
    expect(await identity.hasTotp(userId)).toBe(false);

    // 2. Confirm with the live code → factor confirmed + recovery codes minted once.
    const { recoveryCodes } = await identity.confirmTotp(token, codeFor(secret));

    expect(recoveryCodes).toHaveLength(10);
    expect(await identity.hasTotp(userId)).toBe(true);

    // The secret is stored, but the recovery codes are NOT stored in the clear —
    // only their scrypt hashes (a snapshot yields nothing usable).
    const storedCodes = await db
      .select()
      .from(recoveryCodesTable)
      .where(eq(recoveryCodesTable.userId, userId))
      .all();

    expect(storedCodes).toHaveLength(10);

    for (const stored of storedCodes) {
      expect(stored.codeHash.startsWith("scrypt$")).toBe(true);
      expect(recoveryCodes).not.toContain(stored.codeHash);
      expect(stored.usedAt).toBeNull();
    }

    // 3. Challenge: the second step after a password login verifies the live code.
    //    Advance one step (30s) so the challenge code belongs to a LATER step than
    //    the one `confirmTotp` just recorded — otherwise the confirming code would
    //    be (correctly) refused as a live-window replay (RFC 6238 §5.2).
    now += 30 * 1000;
    await expect(identity.verifyTotpChallenge(userId, codeFor(secret))).resolves.toBeUndefined();
  });

  it("accepts a confirmed factor's confirmedAt as a real Date (timestamp column)", async () => {
    const identity = buildIdentity();
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    await identity.confirmTotp(token, codeFor(secret));

    const factor = await db.select().from(totpFactors).where(eq(totpFactors.userId, userId)).get();

    expect(factor?.confirmed).toBe(true);
    expect(factor?.confirmedAt).toBeInstanceOf(Date);
    expect(factor?.createdAt).toBeInstanceOf(Date);
  });

  it("verifies a single-use recovery code, then refuses its replay", async () => {
    const identity = buildIdentity();
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    const { recoveryCodes } = await identity.confirmTotp(token, codeFor(secret));

    const [code] = recoveryCodes as [string, ...string[]];

    // First use succeeds.
    await expect(identity.verifyRecoveryCode(userId, code)).resolves.toBeUndefined();

    // The same code is now spent — a replay is refused.
    await expect(identity.verifyRecoveryCode(userId, code)).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });

    // A different, still-unused code still works.
    await expect(identity.verifyRecoveryCode(userId, recoveryCodes[1]!)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// enroll — guards
// ---------------------------------------------------------------------------

describe("enrollTotp", () => {
  it("refuses without a live session (IDENTITY_NOT_AUTHENTICATED)", async () => {
    const identity = buildIdentity();

    await expect(identity.enrollTotp(undefined)).rejects.toMatchObject({
      code: "IDENTITY_NOT_AUTHENTICATED",
    });
  });

  it("refuses a session token that resolves to no user", async () => {
    const identity = buildIdentity();
    const { token } = await signedInUser(identity);

    // Delete the user out from under a live session: the session verifies but
    // resolves to no row.
    raw.prepare("DELETE FROM users").run();

    await expect(identity.enrollTotp(token)).rejects.toMatchObject({
      code: "IDENTITY_NOT_AUTHENTICATED",
    });
  });

  it("refuses a forged/garbage session token", async () => {
    const identity = buildIdentity();

    await expect(identity.enrollTotp("not-a-real-token")).rejects.toMatchObject({
      code: "IDENTITY_NOT_AUTHENTICATED",
    });
  });

  it("re-enrolling before confirmation issues a fresh secret", async () => {
    const identity = buildIdentity();
    const { token } = await signedInUser(identity);

    const first = await identity.enrollTotp(token);
    const second = await identity.enrollTotp(token);

    expect(second.secret).not.toBe(first.secret);
    // The old (unconfirmed) code no longer verifies; the new one does.
    await expect(identity.confirmTotp(token, codeFor(first.secret))).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });
    await expect(identity.confirmTotp(token, codeFor(second.secret))).resolves.toMatchObject({
      recoveryCodes: expect.any(Array),
    });
  });

  it("refuses re-enrollment once a factor is confirmed", async () => {
    const identity = buildIdentity();
    const { token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    await identity.confirmTotp(token, codeFor(secret));

    await expect(identity.enrollTotp(token)).rejects.toMatchObject({
      code: "IDENTITY_TOTP_ALREADY_ENROLLED",
    });
  });

  it("uses the default issuer when no appName is configured", async () => {
    // Build directly without `appName` so the option is truly absent (not
    // `undefined`) — the default-issuer branch.
    const identity = createIdentity({
      db,
      secret: "test-secret-0123456789abcdefghij",
      mailer: noopMailer,
      verificationUrl: (token) => `https://app.test/verify?token=${token}`,
      resetUrl: (token) => `https://app.test/reset?token=${token}`,
      sessionStore: sqlSessionStore(sql),
      requireVerifiedEmail: false,
      hasher: cheapHasher,
      clock: () => clock(),
    });
    const { token } = await signedInUser(identity);

    const { keyUri } = await identity.enrollTotp(token);

    expect(keyUri).toContain("otpauth://totp/Lesto:");
  });
});

// ---------------------------------------------------------------------------
// confirm — guards
// ---------------------------------------------------------------------------

describe("confirmTotp", () => {
  it("refuses without a live session", async () => {
    const identity = buildIdentity();

    await expect(identity.confirmTotp(undefined, "000000")).rejects.toMatchObject({
      code: "IDENTITY_NOT_AUTHENTICATED",
    });
  });

  it("refuses confirming before enrollment (IDENTITY_TOTP_NOT_ENROLLED)", async () => {
    const identity = buildIdentity();
    const { token } = await signedInUser(identity);

    await expect(identity.confirmTotp(token, "000000")).rejects.toMatchObject({
      code: "IDENTITY_TOTP_NOT_ENROLLED",
    });
  });

  it("refuses a wrong confirmation code (IDENTITY_INVALID_TOTP)", async () => {
    const identity = buildIdentity();
    const { token } = await signedInUser(identity);

    await identity.enrollTotp(token);

    await expect(identity.confirmTotp(token, "000000")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });
  });

  it("refuses confirming an already-confirmed factor", async () => {
    const identity = buildIdentity();
    const { token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    await identity.confirmTotp(token, codeFor(secret));

    await expect(identity.confirmTotp(token, codeFor(secret))).rejects.toMatchObject({
      code: "IDENTITY_TOTP_ALREADY_ENROLLED",
    });
  });
});

// ---------------------------------------------------------------------------
// challenge verification — guards
// ---------------------------------------------------------------------------

describe("verifyTotpChallenge", () => {
  it("refuses for a user with no factor (enumeration-quiet)", async () => {
    const identity = buildIdentity();
    const { userId } = await signedInUser(identity);

    await expect(identity.verifyTotpChallenge(userId, "000000")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });
  });

  it("refuses for an unconfirmed factor", async () => {
    const identity = buildIdentity();
    const { userId, token } = await signedInUser(identity);

    await identity.enrollTotp(token); // enrolled but not confirmed

    await expect(identity.verifyTotpChallenge(userId, "000000")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });
  });

  it("refuses a wrong code against a confirmed factor", async () => {
    const identity = buildIdentity();
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    await identity.confirmTotp(token, codeFor(secret));

    // A code from far outside the drift window.
    now += 5 * 60 * 1000;

    await expect(identity.verifyTotpChallenge(userId, codeFor(secret))).resolves.toBeUndefined();
    await expect(identity.verifyTotpChallenge(userId, "000000")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });
  });
});

// ---------------------------------------------------------------------------
// recovery-code verification — guards
// ---------------------------------------------------------------------------

describe("verifyRecoveryCode", () => {
  it("refuses for a user with no recovery codes", async () => {
    const identity = buildIdentity();
    const { userId } = await signedInUser(identity);

    await expect(identity.verifyRecoveryCode(userId, "abcd-efgh-ij")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });
  });

  it("refuses an unknown code when valid ones exist", async () => {
    const identity = buildIdentity();
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    await identity.confirmTotp(token, codeFor(secret));

    await expect(identity.verifyRecoveryCode(userId, "zzzz-zzzz-zz")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });
  });

  it("throws an IdentityError instance carrying the code", async () => {
    const identity = buildIdentity();
    const { userId } = await signedInUser(identity);

    try {
      await identity.verifyRecoveryCode(userId, "abcd-efgh-ij");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(IdentityError);
      expect((error as IdentityError).code).toBe("IDENTITY_INVALID_TOTP");
    }
  });
});

// ---------------------------------------------------------------------------
// replay within the live window (RFC 6238 §5.2) — auth-security
// ---------------------------------------------------------------------------

describe("TOTP live-window replay guard", () => {
  it("refuses the SAME code used twice within its window", async () => {
    const identity = buildIdentity();
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    await identity.confirmTotp(token, codeFor(secret));

    // Move one step past the confirm code so the first challenge is itself valid.
    now += 30 * 1000;
    const code = codeFor(secret);

    // First use of this code succeeds and records its step.
    await expect(identity.verifyTotpChallenge(userId, code)).resolves.toBeUndefined();

    // The SAME code, replayed at the same instant (still inside its ±window),
    // matches the same step ≤ last_used_step and is refused.
    await expect(identity.verifyTotpChallenge(userId, code)).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });

    // A persisted last_used_step proves the accepted step was recorded.
    const factor = await db.select().from(totpFactors).where(eq(totpFactors.userId, userId)).get();

    expect(factor?.lastUsedStep).toBeGreaterThan(0);

    // A fresh code from a later step still verifies (the guard is ≤, not a freeze).
    now += 30 * 1000;
    await expect(identity.verifyTotpChallenge(userId, codeFor(secret))).resolves.toBeUndefined();
  });

  it("refuses replaying the confirmation code as the first challenge", async () => {
    const identity = buildIdentity();
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    const code = codeFor(secret);

    // Confirm with `code` — its step is now recorded as last_used_step.
    await identity.confirmTotp(token, code);

    // Re-presenting the confirmation code as a challenge (same step) is a replay.
    await expect(identity.verifyTotpChallenge(userId, code)).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });
  });
});

// ---------------------------------------------------------------------------
// recovery-code single-use is atomic (no check-then-mark race) — auth-security
// ---------------------------------------------------------------------------

describe("recovery-code atomic claim", () => {
  it("a code already marked used cannot be consumed again via the conditional path", async () => {
    const identity = buildIdentity();
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    const { recoveryCodes } = await identity.confirmTotp(token, codeFor(secret));

    // Grab the stored row id for the first code, then mark it used out-of-band —
    // simulating the racing consumer that won the claim first.
    const stored = await db
      .select()
      .from(recoveryCodesTable)
      .where(eq(recoveryCodesTable.userId, userId))
      .all();
    const firstRowId = stored[0]!.id;

    // The conditional UPDATE wins the first time…
    expect(await markRecoveryCodeUsed(db, firstRowId)).toBe(true);
    // …and loses (0 rows) the second time, because `used_at IS NULL` no longer holds.
    expect(await markRecoveryCodeUsed(db, firstRowId)).toBe(false);

    // Through the service: a code whose row is already used is refused — the
    // verifier matches the hash but the atomic claim returns 0 rows (lost race).
    const usedCode = recoveryCodes[0]!;
    await expect(identity.verifyRecoveryCode(userId, usedCode)).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });

    // A still-unused code is unaffected.
    await expect(identity.verifyRecoveryCode(userId, recoveryCodes[1]!)).resolves.toBeUndefined();
  });

  it("refuses when the conditional claim loses the race (0 rows changed)", async () => {
    const identity = buildIdentity();
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    const { recoveryCodes } = await identity.confirmTotp(token, codeFor(secret));

    // The code is still unused (so it surfaces in `findUnusedRecoveryCodes` and the
    // hash matches), but a concurrent consumer claimed it between our read and our
    // UPDATE — force the conditional claim to report 0 rows changed.
    const spy = vi.spyOn(totpRepo, "markRecoveryCodeUsed").mockResolvedValue(false);

    await expect(identity.verifyRecoveryCode(userId, recoveryCodes[0]!)).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// second-factor brute-force throttle (per account) — auth-security
// ---------------------------------------------------------------------------

describe("second-factor throttle", () => {
  it("refuses with IDENTITY_TOTP_THROTTLED after the bucket is drained (challenge)", async () => {
    const identity = buildIdentity({ totpRateLimiter: totpLimiter(3) });
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    await identity.confirmTotp(token, codeFor(secret));
    now += 30 * 1000;

    // Three wrong codes drain the 3-token bucket — each a plain INVALID_TOTP.
    for (let i = 0; i < 3; i++) {
      await expect(identity.verifyTotpChallenge(userId, "000000")).rejects.toMatchObject({
        code: "IDENTITY_INVALID_TOTP",
      });
    }

    // The fourth attempt is throttled — refused BEFORE the secret is touched, with
    // the retry hint in the details.
    const throttled = await identity.verifyTotpChallenge(userId, "000000").catch((e: unknown) => e);
    expect((throttled as IdentityError).code).toBe("IDENTITY_TOTP_THROTTLED");
    expect((throttled as IdentityError).details?.["retryAfterMs"]).toBeGreaterThan(0);

    // Even a VALID code is refused once throttled (the gate is before verification).
    await expect(identity.verifyTotpChallenge(userId, codeFor(secret))).rejects.toMatchObject({
      code: "IDENTITY_TOTP_THROTTLED",
    });
  });

  it("does not throttle on a successful challenge (a real user never locks themselves out)", async () => {
    const identity = buildIdentity({ totpRateLimiter: totpLimiter(2) });
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    await identity.confirmTotp(token, codeFor(secret));

    // Many successful challenges spend nothing — step forward each time so the
    // code is fresh (not a replay), and the bucket stays full.
    for (let i = 0; i < 5; i++) {
      now += 30 * 1000;
      await expect(identity.verifyTotpChallenge(userId, codeFor(secret))).resolves.toBeUndefined();
    }
  });

  it("refuses with IDENTITY_TOTP_THROTTLED after the bucket is drained (recovery)", async () => {
    const identity = buildIdentity({ totpRateLimiter: totpLimiter(2) });
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    const { recoveryCodes } = await identity.confirmTotp(token, codeFor(secret));

    // Two wrong recovery codes drain the 2-token bucket.
    for (let i = 0; i < 2; i++) {
      await expect(identity.verifyRecoveryCode(userId, "zzzz-zzzz-zz")).rejects.toMatchObject({
        code: "IDENTITY_INVALID_TOTP",
      });
    }

    // The next attempt is throttled — even a genuine, still-unused recovery code is
    // refused, because the gate sits before the lookup.
    await expect(identity.verifyRecoveryCode(userId, recoveryCodes[0]!)).rejects.toMatchObject({
      code: "IDENTITY_TOTP_THROTTLED",
    });
  });

  it("shares the bucket across BOTH challenge and recovery for one account", async () => {
    const identity = buildIdentity({ totpRateLimiter: totpLimiter(2) });
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);
    await identity.confirmTotp(token, codeFor(secret));
    now += 30 * 1000;

    // One failed TOTP + one failed recovery drain the shared `totp:<userId>` bucket.
    await expect(identity.verifyTotpChallenge(userId, "000000")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });
    await expect(identity.verifyRecoveryCode(userId, "zzzz-zzzz-zz")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });

    // The third attempt — on EITHER verifier — is throttled.
    await expect(identity.verifyTotpChallenge(userId, codeFor(secret))).rejects.toMatchObject({
      code: "IDENTITY_TOTP_THROTTLED",
    });
  });
});

// ---------------------------------------------------------------------------
// confirmTotp orders recovery-code minting BEFORE the confirmed stamp — auth-security
// ---------------------------------------------------------------------------

describe("confirmTotp crash-ordering", () => {
  it("leaves the factor UNCONFIRMED (re-confirmable) when recovery-code persistence fails", async () => {
    const identity = buildIdentity();
    const { userId, token } = await signedInUser(identity);

    const { secret } = await identity.enrollTotp(token);

    // Make the recovery-code INSERT fail — drop the table so the persist throws
    // AFTER the code verifies but BEFORE the factor is stamped confirmed.
    raw.prepare("DROP TABLE recovery_codes").run();

    await expect(identity.confirmTotp(token, codeFor(secret))).rejects.toThrow();

    // The factor must NOT be confirmed — the stamp comes last, so a crash before it
    // leaves the user re-confirmable rather than locked out (confirmed, no codes).
    expect(await identity.hasTotp(userId)).toBe(false);

    // Restore the table and re-confirm cleanly: the factor was still unconfirmed.
    raw
      .prepare(
        "CREATE TABLE recovery_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code_hash TEXT NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL)",
      )
      .run();
    now += 30 * 1000;
    const { recoveryCodes } = await identity.confirmTotp(token, codeFor(secret));

    expect(recoveryCodes).toHaveLength(10);
    expect(await identity.hasTotp(userId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------

describe("totpMigration", () => {
  it("down drops both factor tables", async () => {
    const migrator = new Migrator(sql, [usersMigration, totpMigration]);

    // Rolling back the most-recent migration reverses the TOTP tables.
    expect(await migrator.rollback()).toBe(totpMigration.version);
    expect(() => raw.prepare("SELECT * FROM recovery_codes").all()).toThrow();
    expect(() => raw.prepare("SELECT * FROM totp_factors").all()).toThrow();
  });
});
