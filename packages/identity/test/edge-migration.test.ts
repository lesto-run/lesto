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

import { expectAuthenticated } from "./authed";

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

// A VALID PBKDF2 hash at an ARBITRARY iteration count, mirroring `@lesto/auth`'s wire
// format — the only way to construct a legacy over-ceiling (`600000`) row, which the
// real minter now refuses to produce. Node's WebCrypto has no cap, so it derives fine.
const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function pbkdf2HashAt(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password) as Uint8Array<ArrayBuffer>,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations },
    keyMaterial,
    32 * 8,
  );

  return `pbkdf2$sha256$${iterations}$${toHex(salt)}$${toHex(new Uint8Array(bits))}`;
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

// A cheap, call-counting hasher whose verify always resolves `false` — for driving the
// credential-failure epilogue and asserting DERIVE COUNTS (never wall-clock).
function spyHasher() {
  const hashPassword = vi
    .fn<(password: string) => Promise<string>>()
    .mockResolvedValue(DECOY_PBKDF2);
  const verifyPassword = vi
    .fn<(password: string, stored: string) => Promise<boolean>>()
    .mockResolvedValue(false);

  return {
    hasher: { ...pbkdf2MigrationHasher, hashPassword, verifyPassword } satisfies PasswordHasher,
    hashPassword,
    verifyPassword,
  };
}

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
    // A current-cost PBKDF2 hash (100k — the edge ceiling) is NOT stale.
    const pbkdf2AtCost = `pbkdf2$sha256$100000$${"00".repeat(16)}$${"00".repeat(32)}`;
    expect(pbkdf2MigrationHasher.needsRehash(pbkdf2AtCost)).toBe(false);
  });

  it("converts a user's scrypt hash to edge-safe (100k) PBKDF2 on their next successful login", async () => {
    const email = "migrate@node.test";
    await seedVerifiedUser(email, cheapScryptHash("correct horse battery staple"));

    // On Node, the migration hasher verifies the existing scrypt hash fine and the
    // rehash-on-login seam re-mints it as edge-safe PBKDF2 — pinned to the 100k edge
    // ceiling so the hash it produces actually runs at the destination it migrates to.
    const identity = createIdentity(build({ hasher: pbkdf2MigrationHasher }));
    const { session } = expectAuthenticated(
      await identity.login(email, "correct horse battery staple"),
    );

    expect(session.token).toBeTruthy();

    const after = await findUserByEmail(db, email);
    expect(after?.passwordHash.startsWith("pbkdf2$sha256$100000$")).toBe(true);

    // Convergence: the re-minted 100k hash is at cost, so a SECOND login does not
    // re-mint it — no re-hash-on-every-login loop (which a `< target` baseline would
    // have caused on the edge, where 100k can never reach a 600k target).
    expect(pbkdf2MigrationHasher.needsRehash(after!.passwordHash)).toBe(false);
    await identity.login(email, "correct horse battery staple");
    const settled = await findUserByEmail(db, email);
    expect(settled?.passwordHash).toBe(after?.passwordHash);
  });

  it("walks a legacy over-ceiling (600k) PBKDF2 row down to 100k on a Node login", async () => {
    // A hybrid app that ran a pre-fix build may hold `pbkdf2$…$600000$…` rows: Node can
    // still verify them (no cap), but the edge cannot derive them. The migration hasher
    // re-mints them to the edge-runnable ceiling on the next login, draining the tail.
    const email = "overcost@node.test";
    await seedVerifiedUser(email, await pbkdf2HashAt("correct horse battery staple", 600_000));

    const identity = createIdentity(build({ hasher: pbkdf2MigrationHasher }));
    const { session } = expectAuthenticated(
      await identity.login(email, "correct horse battery staple"),
    );

    expect(session.token).toBeTruthy();

    const after = await findUserByEmail(db, email);
    expect(after?.passwordHash.startsWith("pbkdf2$sha256$100000$")).toBe(true);
  });
});

// A pure projector over the recorded events — module-scoped (it captures nothing)
// per oxlint's consistent-function-scoping, shared by the assertions below.
const findRehash = (
  events: IdentityEvent[],
): Extract<IdentityEvent, { type: "password_rehashed" }> | undefined =>
  events.find(
    (event): event is Extract<IdentityEvent, { type: "password_rehashed" }> =>
      event.type === "password_rehashed",
  );

describe("password_rehashed event — the rehash-on-login cost transition (L-c6132828)", () => {
  // A migration-hasher identity with an event sink, so the rehash-on-login seam's
  // `password_rehashed` is actually captured.
  function eventfulMigration(): {
    identity: ReturnType<typeof createIdentity>;
    events: IdentityEvent[];
  } {
    const events: IdentityEvent[] = [];
    const identity = createIdentity(
      build({
        hasher: pbkdf2MigrationHasher,
        onEvent: (event) => {
          events.push(event);
        },
      }),
    );

    return { identity, events };
  }

  it("fires with a secret-free DOWN-rehash shape when a 600k PBKDF2 row is walked to 100k", async () => {
    // The footgun: `pbkdf2MigrationHasher` left wired on a non-migrating Node tier
    // walks a strong 600k row DOWN to the 100k edge ceiling on the next login — a
    // one-way ~6× strength reduction that, without this event, no audit could see.
    const email = "down@node.test";
    const legacyHash = await pbkdf2HashAt("correct horse battery staple", 600_000);
    const userId = await seedVerifiedUser(email, legacyHash);

    const { identity, events } = eventfulMigration();
    await identity.login(email, "correct horse battery staple");

    const rehashed = findRehash(events);

    // Full shape: names its subject (rides an authenticated success path), stamps a
    // timestamp, and carries old + new cost.
    expect(rehashed).toEqual({
      type: "password_rehashed",
      userId: String(userId),
      at: expect.any(Number),
      from: { algorithm: "pbkdf2", iterations: 600_000 },
      to: { algorithm: "pbkdf2", iterations: 100_000 },
    });

    // Direction is legible from the payload alone: old cost > new cost == DOWN-rehash.
    const from = rehashed!.from;
    const to = rehashed!.to;
    expect(
      from.algorithm === "pbkdf2" && to.algorithm === "pbkdf2" && from.iterations > to.iterations,
    ).toBe(true);

    // No secret material rides the event: not the password, and neither the salt nor
    // the derived key of the OLD or the freshly minted hash. (The iteration counts DO
    // appear — they are the cost, not a secret — so we assert only salt/key absence.)
    const after = await findUserByEmail(db, email);
    const blob = JSON.stringify(rehashed);
    expect(blob).not.toContain("correct horse battery staple");
    for (const stored of [legacyHash, after!.passwordHash]) {
      const [, , , salt, key] = stored.split("$") as [string, string, string, string, string];
      expect(blob).not.toContain(salt);
      expect(blob).not.toContain(key);
    }
  });

  it("fires an UP-rehash (50k → 100k) — same shape, opposite direction to a DOWN-rehash", async () => {
    const email = "up@node.test";
    const userId = await seedVerifiedUser(email, await pbkdf2HashAt("hunter2hunter2", 50_000));

    const { identity, events } = eventfulMigration();
    await identity.login(email, "hunter2hunter2");

    const rehashed = findRehash(events);

    expect(rehashed).toEqual({
      type: "password_rehashed",
      userId: String(userId),
      at: expect.any(Number),
      from: { algorithm: "pbkdf2", iterations: 50_000 },
      to: { algorithm: "pbkdf2", iterations: 100_000 },
    });

    // The distinguishing test: here old cost < new cost == UP, the mirror of the 600k
    // case above. The payload alone tells the two apart — no side channel needed.
    const from = rehashed!.from;
    const to = rehashed!.to;
    expect(
      from.algorithm === "pbkdf2" && to.algorithm === "pbkdf2" && from.iterations < to.iterations,
    ).toBe(true);
  });

  it("carries the algorithm CHANGE on the flagship scrypt → PBKDF2 migration", async () => {
    // The primary migration: a Node scrypt row re-minted as edge-safe PBKDF2. `from`
    // and `to` name different algorithms, so a cross-KDF move is legible even though
    // it is not a single-scale up/down.
    const email = "cross@node.test";
    const userId = await seedVerifiedUser(email, cheapScryptHash("correct horse battery staple"));

    const { identity, events } = eventfulMigration();
    await identity.login(email, "correct horse battery staple");

    expect(findRehash(events)).toEqual({
      type: "password_rehashed",
      userId: String(userId),
      at: expect.any(Number),
      // `cheapScryptHash` mints `scrypt$2$8$1$…` — read back verbatim (N=2, r=8, p=1).
      from: { algorithm: "scrypt", n: 2, r: 8, p: 1 },
      to: { algorithm: "pbkdf2", iterations: 100_000 },
    });
  });

  it("does NOT fire when the stored hash is already at cost (no rehash persisted)", async () => {
    // A row already at the 100k ceiling is not stale → the seam re-mints nothing → no
    // event. The `login_succeeded` assertion proves the sink WAS wired and simply had
    // no rehash to report — so the absence is real, not a dropped subscription.
    const email = "stable@node.test";
    await seedVerifiedUser(email, await pbkdf2HashAt("correct horse battery staple", 100_000));

    const { identity, events } = eventfulMigration();
    await identity.login(email, "correct horse battery staple");

    expect(findRehash(events)).toBeUndefined();
    expect(events.some((event) => event.type === "login_succeeded")).toBe(true);
  });
});

describe("login failure epilogue — derive-count + shape parity (L-3d530db0)", () => {
  it("a cold isolate's FIRST wrong-password login mints the decoy too", async () => {
    await seedVerifiedUser("wrongpw@edge.test", DECOY_PBKDF2);
    const { hasher, hashPassword, verifyPassword } = spyHasher();
    const events: IdentityEvent[] = [];
    const identity = createIdentity(
      build({
        hasher,
        onEvent: (event) => {
          events.push(event);
        },
      }),
    );

    await expect(identity.login("wrongpw@edge.test", "wrong")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_CREDENTIALS",
    });

    // The amortized first-failure mint. BEFORE this fix the wrong-password path never
    // touched the decoy (`hashPassword` 0×), so a cold isolate's first wrong-password
    // out-costed its first unknown-email — a recurring cold-vs-existence timing oracle.
    // This assertion is 0 (RED) without the fix.
    expect(hashPassword).toHaveBeenCalledTimes(1);
    // One real verify, NO decoy verify (the real one already ran → spendDecoy=false).
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    // Shape parity: exactly one login_failed, carrying NO userId.
    expect(events).toEqual([{ type: "login_failed", at: expect.any(Number) }]);
  });

  it("a cold isolate's FIRST unknown-email login costs one mint + one decoy verify", async () => {
    const { hasher, hashPassword, verifyPassword } = spyHasher();
    const events: IdentityEvent[] = [];
    const identity = createIdentity(
      build({
        hasher,
        onEvent: (event) => {
          events.push(event);
        },
      }),
    );

    await expect(identity.login("nobody@edge.test", "wrong")).rejects.toMatchObject({
      code: "IDENTITY_INVALID_CREDENTIALS",
    });

    expect(hashPassword).toHaveBeenCalledTimes(1); // decoy mint
    expect(verifyPassword).toHaveBeenCalledTimes(1); // decoy verify (no real user)
    expect(events).toEqual([{ type: "login_failed", at: expect.any(Number) }]);
  });

  it("memoizes the decoy — a second failure (any type) does NOT re-mint", async () => {
    await seedVerifiedUser("again@edge.test", DECOY_PBKDF2);
    const { hasher, hashPassword } = spyHasher();
    const identity = createIdentity(build({ hasher }));

    await identity.login("again@edge.test", "wrong").catch(() => undefined);
    await identity.login("stranger@edge.test", "wrong").catch(() => undefined);

    // One mint total across two failures of DIFFERENT types (wrong-password, then
    // unknown-email) — the decoy is cached for the isolate's lifetime.
    expect(hashPassword).toHaveBeenCalledTimes(1);
  });
});
