import { randomBytes, scryptSync } from "node:crypto";

import { verifyPassword, verifyRecoveryCode } from "@lesto/auth";

import type { PasswordHasher } from "../src/index";

/**
 * A deliberately CHEAP scrypt hasher for the identity suite.
 *
 * The production {@link PasswordHasher} runs `@lesto/auth`'s KDF at N=2^17
 * (~150 ms/derive) — correct for a real deployment, but crippling in a unit suite
 * that hashes dozens of times (every register, every login, and ten recovery-code
 * digests per TOTP confirm). This hasher mints in the SAME self-describing format
 * (`scrypt$N$r$p$salt$hash`) at N=2, turning each derive into microseconds.
 *
 * Only *minting* is cheapened: `verifyPassword`/`verifyRecoveryCode` delegate to
 * the REAL `@lesto/auth` verifiers, which derive at the cost read back from the
 * stored string (so an N=2 hash still verifies in microseconds). That keeps the
 * fail-closed parser a single source of truth instead of a forked copy that could
 * drift. `needsRehash` is pinned `false`: nothing this hasher mints is ever "stale"
 * against itself — the legacy→current upgrade path is exercised by the rehash-on-
 * login tests, which keep the real production hasher.
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

export const cheapHasher: PasswordHasher = {
  hashPassword: (password) => Promise.resolve(cheapHash(password)),
  verifyPassword,
  needsRehash: () => false,
  hashRecoveryCodes: (codes) => Promise.all(codes.map((code) => Promise.resolve(cheapHash(code)))),
  verifyRecoveryCode,
};
