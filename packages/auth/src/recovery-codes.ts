/**
 * Single-use recovery codes — the break-glass second-factor backup.
 *
 *   const codes = generateRecoveryCodes();          // 10 plaintext codes, shown ONCE
 *   const hashes = await hashRecoveryCodes(codes);  // KDF digests, stored at rest
 *   await verifyRecoveryCode("a1b2-c3d4-e5", hash); // true iff it matches
 *
 * Recovery codes let a user who has lost their authenticator still prove the
 * second factor. They are **hashed at rest with the SAME primitive the password
 * path uses** ({@link hashPassword} / {@link verifyPassword}) — the runtime-adaptive
 * KDF (scrypt on Node, PBKDF2 on the edge), with deliberately no second hasher. A
 * database snapshot therefore yields no usable codes, exactly as it yields no usable
 * passwords.
 *
 * The plaintext codes are returned by {@link generateRecoveryCodes} once, at
 * generation, for the app to display to the user; only their digests are
 * persisted. Single-use is the *caller's* job (mark the matched row consumed) —
 * this module owns generation + the constant-time hash compare, not the storage.
 */

import { randomBytes } from "node:crypto";

import { hashPassword, verifyPassword } from "./password";

/** How many codes a fresh batch contains — the better-auth / GitHub default. */
const DEFAULT_COUNT = 10;

/**
 * Symbols per code. Each maps one random byte through a 30-symbol alphabet
 * (≈ 4.9 bits/symbol), so 10 symbols ≈ 49 bits — ample for a single-use backup an
 * attacker gets one guess at, and short enough to type off paper.
 */
const CODE_BYTES = 10;

/**
 * Crockford-ish base32 alphabet, minus the visually-ambiguous `I L O U` and any
 * digit that collides with a letter — so a human reading a printed code off paper
 * cannot fat-finger an `O` for a `0`. Power-of-two size keeps the masking unbiased.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/**
 * Format raw bytes into a grouped, human-friendly code like `a1b2-c3d4-e5`.
 *
 * Each byte maps to one alphabet symbol via a modulo into a 30-symbol set — close
 * enough to uniform for a single-use backup code (the tiny bias across a 256→30
 * fold is irrelevant against 80 bits of total entropy). Lowercased and hyphenated
 * in groups of four for legibility.
 */
function formatCode(bytes: Buffer): string {
  const symbols: string[] = [];

  for (const byte of bytes) {
    symbols.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]!);
  }

  // Group every four symbols with a hyphen for readability when typed/printed.
  // `CODE_BYTES` (≥ 1) guarantees a non-empty string, so the regex always matches.
  return symbols
    .join("")
    .replace(/(.{4})(?=.)/g, "$1-")
    .toLowerCase();
}

/**
 * Generate a fresh batch of `count` random, single-use recovery codes (plaintext).
 *
 * The returned strings are shown to the user ONCE and never stored as-is — the
 * caller persists only {@link hashRecoveryCodes}'s digests. Each code carries
 * ~49 bits of entropy (10 symbols from a 30-symbol alphabet).
 */
export function generateRecoveryCodes(count: number = DEFAULT_COUNT): string[] {
  const codes: string[] = [];

  for (let i = 0; i < count; i += 1) {
    codes.push(formatCode(randomBytes(CODE_BYTES)));
  }

  return codes;
}

/**
 * Hash a batch of plaintext codes with the password path's KDF.
 *
 * Reuses {@link hashPassword} verbatim — the same self-describing, re-hashable,
 * cost-parameterized, runtime-adaptive format passwords use (scrypt on Node, PBKDF2
 * on the edge) — so recovery codes are protected at rest identically and there is
 * one hashing implementation to audit, not two.
 */
export async function hashRecoveryCodes(codes: readonly string[]): Promise<string[]> {
  return await Promise.all(codes.map((code) => hashPassword(code)));
}

/**
 * Verify a candidate recovery code against one stored hash, in constant time.
 *
 * A thin alias over {@link verifyPassword}: resolves `false` (never rejects) for a
 * malformed stored hash, and compares the derived key in constant time. Single-use
 * enforcement (marking the matched code consumed so a replay is refused) is the
 * caller's, after a `true`.
 */
export async function verifyRecoveryCode(code: string, storedHash: string): Promise<boolean> {
  return await verifyPassword(code, storedHash);
}
