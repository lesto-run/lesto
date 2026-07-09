import { randomBytes, scryptSync } from "node:crypto";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthError } from "@lesto/auth";
import { createDb } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";

import {
  createIdentity,
  findUserByEmail,
  insertUser,
  pbkdf2MigrationHasher,
  totpMigration,
  usersMigration,
} from "../src/index";

import * as totpRepo from "../src/totp";

import type { IdentityEvent, IdentityMailer, IdentityOptions, PasswordHasher } from "../src/index";

// ---------------------------------------------------------------------------
// Test rig — one in-memory SQLite per test, the same handle adapted for both the
// @lesto/db ORM surface and @lesto/migrate's DDL. Mirrors identity.test.ts's rig,
// kept self-contained so this feature's tests live in one file (shared-worktree).
// ---------------------------------------------------------------------------

let raw: Database.Database;
let db: Db;

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

const SECRET = "test-secret-0123456789abcdefghij";

function build(opts: Partial<IdentityOptions> = {}): IdentityOptions {
  return {
    db,
    secret: SECRET,
    mailer: noopMailer,
    verificationUrl: (token) => `https://app.test/verify?token=${token}`,
    resetUrl: (token) => `https://app.test/reset?token=${token}`,
    ...opts,
  };
}

// A cheap but VALID scrypt hash (N=2) — verifiable by the real KDF on Node, and a
// realistic `scrypt$…` row for the migration/edge-refusal paths.
function cheapScryptHash(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 2, r: 8, p: 1 });

  return `scrypt$2$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
}

// A PBKDF2-shaped decoy the fake hasher mints for the timing decoy — its content is
// irrelevant (the fake's verify returns false for any non-scrypt hash).
const DECOY_PBKDF2 = `pbkdf2$sha256$1$${"00".repeat(16)}$${"00".repeat(32)}`;

/**
 * A hasher that mimics the edge: it MINTS PBKDF2 (so the timing decoy never itself
 * refuses) but REFUSES to verify any `scrypt$…` hash by throwing `error` — exactly
 * what `@lesto/auth`'s `verifyPassword` does on a Workers isolate.
 */
function edgeRefusingHasher(rejection: unknown) {
  const hashPassword = vi
    .fn<(password: string) => Promise<string>>()
    .mockResolvedValue(DECOY_PBKDF2);
  // The FIRST verify (the real stored-hash check) refuses; every later call (the
  // timing decoy) resolves. Order matches `login`: real hash, then decoy.
  const verifyPassword = vi
    .fn<(password: string, stored: string) => Promise<boolean>>()
    .mockRejectedValueOnce(rejection)
    .mockResolvedValue(false);

  // Only hash/verify matter for these paths; take the real preset's recovery-code +
  // needsRehash slots (never invoked on the throw paths) so the fake stays minimal.
  return {
    hasher: { ...pbkdf2MigrationHasher, hashPassword, verifyPassword } satisfies PasswordHasher,
    hashPassword,
    verifyPassword,
  };
}

const kdfUnavailable = (): AuthError =>
  new AuthError("AUTH_KDF_UNAVAILABLE", "scrypt cannot run here", { algorithm: "scrypt" });

beforeEach(async () => {
  raw = new Database(":memory:");
  db = createDb(adapt(raw));

  await new Migrator(adapt(raw), [usersMigration, totpMigration]).migrate();
});

afterEach(() => {
  raw.close();
  vi.restoreAllMocks();
});

async function seedVerifiedUser(email: string, passwordHash: string): Promise<number> {
  const user = await insertUser(db, {
    email,
    passwordHash,
    emailVerifiedAt: new Date().toISOString(),
  });

  return user.id;
}

describe("login — an unverifiable (scrypt-on-edge) hash", () => {
  it("refuses with IDENTITY_INVALID_CREDENTIALS by default, timing-matched to a wrong password", async () => {
    await seedVerifiedUser("ada@edge.test", cheapScryptHash("correct horse battery staple"));

    const events: IdentityEvent[] = [];
    const { hasher, hashPassword, verifyPassword } = edgeRefusingHasher(kdfUnavailable());
    const identity = createIdentity(
      build({
        hasher,
        onEvent: (event) => {
          events.push(event);
        },
      }),
    );

    await expect(
      identity.login("ada@edge.test", "correct horse battery staple"),
    ).rejects.toMatchObject({
      code: "IDENTITY_INVALID_CREDENTIALS",
    });

    // Timing parity: the refuse path ran NO derive, so it must spend one decoy — the
    // stored hash (throws) AND the decoy (pbkdf2) are both verified, and the decoy was
    // minted once. If the decoy were omitted this branch would be one derive short of a
    // wrong-password attempt (a detectable oracle) — this assertion would then go red.
    expect(verifyPassword).toHaveBeenCalledTimes(2);
    expect(hashPassword).toHaveBeenCalledTimes(1);

    // Enumeration-quiet: exactly one login_failed, carrying NO userId.
    expect(events).toEqual([{ type: "login_failed", at: expect.any(Number) }]);
  });

  it("refuses with IDENTITY_PASSWORD_RESET_REQUIRED when the app opts into require_reset", async () => {
    await seedVerifiedUser("grace@edge.test", cheapScryptHash("hunter2hunter2"));

    const { hasher } = edgeRefusingHasher(kdfUnavailable());
    const identity = createIdentity(build({ hasher, onUnverifiableHash: "require_reset" }));

    await expect(identity.login("grace@edge.test", "hunter2hunter2")).rejects.toMatchObject({
      code: "IDENTITY_PASSWORD_RESET_REQUIRED",
    });
  });

  it("propagates a non-KDF error from the hasher (does not swallow it as a login failure)", async () => {
    await seedVerifiedUser("boom@edge.test", cheapScryptHash("password12345"));

    const { hasher } = edgeRefusingHasher(new Error("transient KDF fault"));
    const identity = createIdentity(build({ hasher }));

    await expect(identity.login("boom@edge.test", "password12345")).rejects.toThrow(
      "transient KDF fault",
    );
  });
});

describe("verifyRecoveryCode — an unverifiable (scrypt-on-edge) code hash", () => {
  it("fails closed to IDENTITY_INVALID_TOTP when the KDF is unavailable", async () => {
    const userId = await seedVerifiedUser("recover@edge.test", DECOY_PBKDF2);
    await totpRepo.replaceRecoveryCodes(db, userId, [cheapScryptHash("a1b2-c3d4-e5")]);

    const verifyRecoveryCode = vi
      .fn<(code: string, storedHash: string) => Promise<boolean>>()
      .mockRejectedValue(kdfUnavailable());
    const identity = createIdentity(
      build({ hasher: { ...pbkdf2MigrationHasher, verifyRecoveryCode } }),
    );

    await expect(identity.verifyRecoveryCode(userId, "a1b2-c3d4-e5")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_TOTP",
    });
    expect(verifyRecoveryCode).toHaveBeenCalled();
  });

  it("propagates a non-KDF error from the recovery-code hasher", async () => {
    const userId = await seedVerifiedUser("recover2@edge.test", DECOY_PBKDF2);
    await totpRepo.replaceRecoveryCodes(db, userId, [cheapScryptHash("f6g7-h8j9-k0")]);

    const verifyRecoveryCode = vi
      .fn<(code: string, storedHash: string) => Promise<boolean>>()
      .mockRejectedValue(new Error("recovery KDF fault"));
    const identity = createIdentity(
      build({ hasher: { ...pbkdf2MigrationHasher, verifyRecoveryCode } }),
    );

    await expect(identity.verifyRecoveryCode(userId, "f6g7-h8j9-k0")).rejects.toThrow(
      "recovery KDF fault",
    );
  });
});

describe("pbkdf2MigrationHasher", () => {
  it("flags a scrypt/legacy hash for rehash but defers a PBKDF2 hash to its own cost check", () => {
    // Non-PBKDF2 (a migration candidate) is always stale → the login seam converts it.
    expect(pbkdf2MigrationHasher.needsRehash(cheapScryptHash("x"))).toBe(true);
    expect(pbkdf2MigrationHasher.needsRehash("scrypt$aa$bb")).toBe(true); // legacy form
    // A current-cost PBKDF2 hash is NOT stale.
    const pbkdf2AtCost = `pbkdf2$sha256$600000$${"00".repeat(16)}$${"00".repeat(32)}`;
    expect(pbkdf2MigrationHasher.needsRehash(pbkdf2AtCost)).toBe(false);
  });

  it("converts a user's scrypt hash to PBKDF2 on their next successful login (convert-on-login)", async () => {
    const email = "migrate@node.test";
    await seedVerifiedUser(email, cheapScryptHash("correct horse battery staple"));

    // On Node, the migration hasher verifies the existing scrypt hash fine and the
    // rehash-on-login seam re-mints it as edge-safe PBKDF2.
    const identity = createIdentity(build({ hasher: pbkdf2MigrationHasher }));
    const { session } = await identity.login(email, "correct horse battery staple");

    expect(session.token).toBeTruthy();

    const after = await findUserByEmail(db, email);
    expect(after?.passwordHash.startsWith("pbkdf2$sha256$600000$")).toBe(true);
  });
});
