import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installSessionSchema, sqlSessionStore, totpCode } from "@lesto/auth";
import { createDb, eq } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";

import { createIdentity, IdentityError, totpMigration } from "../src/index";
import { recoveryCodes as recoveryCodesTable, totpFactors } from "../src/totp";
import { usersMigration } from "../src/user";

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
});

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
