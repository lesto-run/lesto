/**
 * TOTP (RFC 6238) on `node:crypto` — the time-based one-time-password primitive,
 * dependency-free.
 *
 *   const secret = generateTotpSecret();                 // base32, 160-bit
 *   const code   = totpCode(secret);                     // the current 6 digits
 *   verifyTotp(secret, code);                            // true (within ±1 step)
 *   totpKeyUri({ secret, issuer: "Lesto", account: "ada@example.com" });
 *   //   otpauth://totp/Lesto:ada%40example.com?secret=…&issuer=Lesto&…
 *
 * TOTP is HOTP (RFC 4226) with the counter derived from the clock: the moving
 * factor is `floor(epochSeconds / timeStep)`, hashed with HMAC-SHA1 under the
 * shared secret, dynamically truncated to a fixed number of digits. An
 * authenticator app (Google Authenticator, 1Password, …) computes the same value
 * from the same secret + clock, so a matching code proves the user holds the
 * secret *now* — a second factor that a stolen password alone cannot satisfy.
 *
 * Three correctness properties this module is built around, mirroring
 * {@link verifyPassword}:
 *
 *   - **Fail closed.** A malformed secret (non-base32) or a malformed code
 *     (wrong length, non-digit) verifies to `false` — never throws. A caller
 *     comparing untrusted input never has to wrap this in a try/catch, and no
 *     malformed input can make verification pass.
 *   - **Constant-time comparison.** Each candidate code is compared with
 *     `timingSafeEqual` over equal-length buffers, so the check leaks no timing.
 *   - **Drift tolerant.** `verifyTotp` accepts a code from `±window` steps
 *     (default ±1 = ±30 s) so a slightly fast/slow authenticator still verifies,
 *     without widening the window so far that a guess becomes feasible.
 *
 * **The shared secret cannot be one-way hashed.** Unlike a password, the verifier
 * must *recompute* the code, so it holds the secret in a recoverable form. At-rest
 * protection of that secret is the deployment's encryption responsibility (see
 * ADR 0020) — this module never logs or returns it except at enrollment.
 *
 * SHA1 is the RFC 6238 default and what authenticator apps assume; it is used here
 * as the HMAC PRF (not as a collision-resistant digest), which is sound.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Clock } from "./types";
import { systemClock } from "./time";

/** RFC 4648 base32 alphabet (no padding) — the encoding authenticator apps speak. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Default TOTP knobs — the RFC 6238 recommendations every authenticator app assumes. */
const DEFAULT_TIME_STEP_SECONDS = 30;
const DEFAULT_DIGITS = 6;

/** Default drift tolerance: ±1 step (±30 s) on each side of "now". */
const DEFAULT_WINDOW = 1;

/** Secret width in bytes — 160 bits, the RFC 6238 SHA1 recommendation. */
const SECRET_BYTES = 20;

/** Knobs shared by code generation and verification. */
export interface TotpOptions {
  /** Seconds per step. Default 30 (the universal authenticator-app value). */
  readonly timeStep?: number;

  /** Digits in the code. Default 6. */
  readonly digits?: number;

  /** Injected clock (epoch ms). Tests pass one so codes are deterministic. */
  readonly clock?: Clock;
}

/** Verification knobs — {@link TotpOptions} plus the drift window. */
export interface TotpVerifyOptions extends TotpOptions {
  /**
   * How many steps on EACH side of "now" to accept. Default 1 (±30 s). A code
   * computed at step `t` verifies for any check in `[t-window, t+window]`.
   */
  readonly window?: number;
}

/**
 * Encode bytes as unpadded RFC 4648 base32 (uppercase).
 *
 * Accumulates bits MSB-first into a sliding buffer and emits one alphabet symbol
 * per 5 bits — the standard streaming base32 encode, no padding (authenticator-app
 * convention).
 *
 * **Precondition: `bytes.length` is a multiple of 5** (40 bits = 8 base32 symbols),
 * so encoding never leaves a trailing partial group. The only caller
 * ({@link generateTotpSecret}) passes {@link SECRET_BYTES} = 20, which satisfies
 * this — keeping the encoder branch-free rather than carrying an unreachable
 * partial-group flush. A non-conforming input would silently drop the tail, hence
 * the guard {@link generateTotpSecret} maintains by construction.
 */
function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }

  return out;
}

/**
 * Decode an RFC 4648 base32 string back to bytes, or `undefined` if it is not
 * valid base32.
 *
 * Case-insensitive; ignores `=` padding and surrounding whitespace (authenticator
 * apps display secrets in spaced, sometimes lowercase groups). Returns `undefined`
 * — never throws — on any out-of-alphabet character, so verification can fail
 * closed on a corrupt stored secret.
 */
function base32Decode(input: string): Buffer | undefined {
  const cleaned = input.replace(/[\s=]/g, "").toUpperCase();

  if (cleaned.length === 0) return undefined;

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);

    // Any symbol outside the alphabet means this is not a secret we produced.
    if (index === -1) return undefined;

    value = (value << 5) | index;
    bits += 5;

    while (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }

  return Buffer.from(out);
}

/**
 * Generate a fresh, cryptographically random base32 TOTP secret (160 bits).
 *
 * The returned string is what an authenticator app scans (via {@link totpKeyUri})
 * and what the verifier stores. 160 bits is the RFC 6238 recommendation for the
 * SHA1 HMAC the OTP standard uses.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** Big-endian 8-byte buffer of an unsigned integer counter (RFC 4226 §5.1). */
function counterBuffer(counter: number): Buffer {
  const buf = Buffer.alloc(8);

  // `writeBigUInt64BE` keeps the full 64-bit counter exact — `Math.floor` of a
  // realistic epoch/timeStep is well within Number's safe-integer range, and
  // BigInt sidesteps the 32-bit bitwise pitfalls entirely.
  buf.writeBigUInt64BE(BigInt(counter));

  return buf;
}

/**
 * The HOTP value for a given secret + counter (RFC 4226 §5.3).
 *
 * Returns `undefined` for a non-base32 secret so callers can fail closed. The
 * dynamic-truncation offset is the low nibble of the final HMAC byte; the 31-bit
 * window from there, mod `10^digits`, zero-padded, is the code.
 */
function hotp(secret: string, counter: number, digits: number): string | undefined {
  const key = base32Decode(secret);

  if (key === undefined) return undefined;

  const hmac = createHmac("sha1", key).update(counterBuffer(counter)).digest();

  // Dynamic truncation: the last nibble selects a 4-byte window; mask the top bit
  // to stay positive (RFC 4226 §5.3).
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The step counter for the given clock + step size (RFC 6238). */
function counterFor(clock: Clock, timeStep: number): number {
  return Math.floor(clock() / 1000 / timeStep);
}

/**
 * The current TOTP code for `secret`.
 *
 * Returns `undefined` only when `secret` is not valid base32 — the same
 * fail-closed contract as the verifier; a well-formed secret always yields a
 * digit string of the requested width.
 */
export function totpCode(secret: string, options: TotpOptions = {}): string | undefined {
  const timeStep = options.timeStep ?? DEFAULT_TIME_STEP_SECONDS;
  const digits = options.digits ?? DEFAULT_DIGITS;
  const clock = options.clock ?? systemClock;

  return hotp(secret, counterFor(clock, timeStep), digits);
}

/**
 * Constant-time equality over two digit strings.
 *
 * The only caller ({@link verifyTotp}) compares the expected code against a
 * candidate it has already validated to be exactly `digits` long — and the
 * expected code is `padStart(digits)` — so both operands are always the same
 * length here; no length guard is needed before `timingSafeEqual` (which would
 * otherwise throw on a mismatch).
 */
function codesMatch(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Verify a candidate code against `secret`, returning the **matched step counter**
 * (the RFC 6238 moving factor `floor(epochSeconds / timeStep)` of the step the
 * code belongs to), or `undefined` when nothing matched.
 *
 * This is {@link verifyTotp}'s engine — it carries the same fail-closed,
 * constant-time, ±`window` drift contract — but surfaces *which* step matched so a
 * caller can enforce single-use within the live window (RFC 6238 §5.2): persist
 * the returned step and refuse any later code whose step is ≤ it. The truncation
 * math is untouched; this only reports the offset that already won the compare.
 *
 * Total and fail-closed: a non-base32 secret, a wrong-length or non-digit code, or
 * simply no match across the window all return `undefined` — never an exception.
 */
export function verifyTotpStep(
  secret: string,
  code: string,
  options: TotpVerifyOptions = {},
): number | undefined {
  const timeStep = options.timeStep ?? DEFAULT_TIME_STEP_SECONDS;
  const digits = options.digits ?? DEFAULT_DIGITS;
  const window = options.window ?? DEFAULT_WINDOW;
  const clock = options.clock ?? systemClock;

  // A code that is not exactly `digits` ASCII digits cannot match any step;
  // reject early so we never feed garbage to the constant-time compare.
  if (!new RegExp(`^[0-9]{${digits}}$`).test(code)) return undefined;

  const base = counterFor(clock, timeStep);

  for (let offset = -window; offset <= window; offset += 1) {
    const step = base + offset;
    const expected = hotp(secret, step, digits);

    // `undefined` means a bad secret — fail closed for every offset.
    if (expected === undefined) return undefined;

    if (codesMatch(expected, code)) return step;
  }

  return undefined;
}

/**
 * Verify a candidate code against `secret`, tolerating ±`window` steps of drift.
 *
 * Total and fail-closed: a non-base32 secret, a wrong-length or non-digit code,
 * or simply no match across the window all return `false` — never an exception.
 * Each step's expected code is compared in constant time. The window default
 * (±1) accepts a code that is up to one step (30 s) stale or early, covering
 * clock skew between the server and the authenticator without meaningfully
 * widening the guess space.
 *
 * A thin boolean façade over {@link verifyTotpStep} (which additionally reports
 * the matched step for single-use enforcement).
 */
export function verifyTotp(secret: string, code: string, options: TotpVerifyOptions = {}): boolean {
  return verifyTotpStep(secret, code, options) !== undefined;
}

/** The fields a provisioning URI carries. */
export interface TotpKeyUriOptions {
  /** The base32 secret an authenticator app scans. */
  readonly secret: string;

  /** The issuer (your app name) shown in the authenticator. */
  readonly issuer: string;

  /** The account label (typically the user's email) shown in the authenticator. */
  readonly account: string;

  /** Code width to embed. Default 6. */
  readonly digits?: number;

  /** Step size to embed, seconds. Default 30. */
  readonly timeStep?: number;
}

/**
 * Build the standard `otpauth://totp/...` provisioning URI (the "key URI format").
 *
 * This is the *data* an authenticator app consumes — typically rendered as a QR
 * code by the app's frontend. We return the URI rather than a QR image so the
 * package stays dependency-free and edge-safe; any QR library encodes this string.
 * Issuer and account are percent-encoded so an email account or a spaced issuer
 * round-trips intact.
 */
export function totpKeyUri(options: TotpKeyUriOptions): string {
  const issuer = encodeURIComponent(options.issuer);
  const account = encodeURIComponent(options.account);
  const label = `${issuer}:${account}`;

  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: "SHA1",
    digits: String(options.digits ?? DEFAULT_DIGITS),
    period: String(options.timeStep ?? DEFAULT_TIME_STEP_SECONDS),
  });

  return `otpauth://totp/${label}?${params.toString()}`;
}
