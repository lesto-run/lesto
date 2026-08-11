/**
 * Errors carry codes, not just prose.
 *
 * Every failure in identity surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type IdentityErrorCode =
  | "IDENTITY_EMAIL_TAKEN"
  | "IDENTITY_INVALID_EMAIL"
  | "IDENTITY_WEAK_PASSWORD"
  | "IDENTITY_WEAK_SECRET"
  | "IDENTITY_INVALID_CREDENTIALS"
  | "IDENTITY_EMAIL_NOT_VERIFIED"
  | "IDENTITY_LOGIN_THROTTLED"
  | "IDENTITY_INVALID_TOKEN"
  /**
   * The signed second-factor challenge minted by {@link Identity.login} for a
   * 2FA-enabled account is missing, forged, or expired — so
   * {@link Identity.completeTotpChallenge} cannot prove the first factor
   * (password) already succeeded and refuses to mint a session. The fix is to
   * sign in again to obtain a fresh challenge. Not an enumeration oracle: the
   * challenge is unforgeable and this reveals nothing about which account (if
   * any) it named.
   */
  | "IDENTITY_INVALID_CHALLENGE"
  /**
   * Login could not verify this account's stored password hash on this runtime —
   * a `scrypt$…` hash reaching a Cloudflare Workers isolate, where the derive would
   * OOM (a migrated / hybrid corpus). Only surfaced when the app opts into
   * {@link IdentityOptions.onUnverifiableHash} `"require_reset"`; the default keeps the
   * enumeration-safe `IDENTITY_INVALID_CREDENTIALS`. The fix is a password reset,
   * which re-mints the hash as edge-safe PBKDF2.
   */
  | "IDENTITY_PASSWORD_RESET_REQUIRED"
  /**
   * The configured `sessionStore` cannot revoke a user's sessions (it has no
   * `deleteByUserId`) and no {@link IdentityOptions.revokeUserSessions} hook was
   * wired — so `resetPassword`'s revoke-on-reset promise would silently not hold
   * and a victim's reset would leave an attacker's stolen session alive. Refused
   * at construction, not at reset time: give the store a
   * `deleteByUserId(userId)` (both built-ins — `MemorySessionStore` and
   * `sqlSessionStore` — have one), or wire `revokeUserSessions` for a store that
   * genuinely cannot (e.g. a stateless signed-token tier, ADR 0013 §8).
   */
  | "IDENTITY_SESSION_STORE_NOT_REVOCABLE"
  // --- second factor (TOTP, ADR 0020) ---
  /** No live session backed the call that must be made by a signed-in user. */
  | "IDENTITY_NOT_AUTHENTICATED"
  /** A TOTP factor is already enrolled + confirmed; re-enrolling is refused. */
  | "IDENTITY_TOTP_ALREADY_ENROLLED"
  /** No (confirmed) TOTP factor exists for the user the challenge targets. */
  | "IDENTITY_TOTP_NOT_ENROLLED"
  /** A TOTP code or recovery code did not verify (enumeration-quiet). */
  | "IDENTITY_INVALID_TOTP"
  /** Too many failed second-factor attempts for this user; the bucket is drained. */
  | "IDENTITY_TOTP_THROTTLED";

/** Anything the identity layer can refuse to do. */
export class IdentityError extends LestoError<IdentityErrorCode> {
  constructor(code: IdentityErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "IdentityError";
  }
}

/** The minimum acceptable signing-secret length, in bytes (256 bits of key material). */
export const MIN_SECRET_BYTES = 32;

/**
 * Refuse a signing secret weaker than {@link MIN_SECRET_BYTES} at construction.
 *
 * The verification- and reset-token signatures are HMACs under this secret; a
 * short or empty secret (a placeholder, an env var that resolved to "") makes
 * every email-verification and password-reset token forgeable. Refused when the
 * identity is built, so a weak key is a startup error, not a silent hole.
 */
export function assertStrongSecret(secret: string): void {
  const bytes = Buffer.byteLength(secret, "utf8");

  if (bytes < MIN_SECRET_BYTES) {
    throw new IdentityError(
      "IDENTITY_WEAK_SECRET",
      `Signing secret is too weak: ${bytes} bytes, need at least ${MIN_SECRET_BYTES}.`,
      { bytes, minBytes: MIN_SECRET_BYTES },
    );
  }
}
