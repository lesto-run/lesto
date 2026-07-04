import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { PasswordHasher } from "../src/index";

/**
 * A deliberately CHEAP scrypt hasher for the identity suite.
 *
 * The production {@link PasswordHasher} runs `@lesto/auth`'s KDF at N=2^17
 * (~150 ms/derive) — correct for a real deployment, but crippling in a unit suite
 * that hashes dozens of times (every register, every login, and ten recovery-code
 * digests per TOTP confirm). This implementation mints the SAME self-describing
 * format (`scrypt$N$r$p$salt$hash`) so every identity code path — verify, the
 * rehash check, the recovery-code round-trip — behaves identically; only the work
 * factor drops to N=2, turning each derive into microseconds.
 *
 * Injected via {@link import("../src/index").IdentityOptions.hasher}; the
 * production default is never under-costed by this — a test opts in explicitly.
 */

const N = 2;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** Hash a secret with a fresh salt at the cheap cost, in the auth-compatible format. */
function cheapHash(secret: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(secret, salt, KEY_BYTES, { N, r: R, p: P });

  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Verify a candidate against a cheap-format stored hash, constant-time.
 *
 * Returns `false` (never throws) for anything this hasher could not have minted —
 * the cheap suite only ever feeds it hashes it produced, but failing closed keeps
 * it a faithful stand-in for the production verifier.
 */
function cheapVerify(secret: string, stored: string): boolean {
  const parts = stored.split("$");

  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");

  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;

  const actual = scryptSync(secret, salt, KEY_BYTES, {
    N: Number(nRaw),
    r: Number(rRaw),
    p: Number(pRaw),
  });

  return timingSafeEqual(actual, expected);
}

export const cheapHasher: PasswordHasher = {
  hashPassword: (password) => Promise.resolve(cheapHash(password)),
  verifyPassword: (password, stored) => Promise.resolve(cheapVerify(password, stored)),
  // The cheap hasher already mints at its own current cost, so nothing it produces
  // is ever "stale" — the legacy→current upgrade path is exercised by the two
  // rehash-on-login tests, which keep the REAL production hasher.
  needsRehash: () => false,
  hashRecoveryCodes: (codes) => Promise.all(codes.map((code) => Promise.resolve(cheapHash(code)))),
  verifyRecoveryCode: (code, storedHash) => Promise.resolve(cheapVerify(code, storedHash)),
};
