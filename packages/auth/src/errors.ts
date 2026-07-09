/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type AuthErrorCode =
  | "AUTH_INVALID_HASH"
  | "AUTH_WEAK_SECRET"
  /**
   * A stored hash names a KDF this runtime cannot execute — e.g. a `scrypt$…` hash
   * reaching a Cloudflare Workers isolate, where the memory-hard derive would OOM.
   * `verifyPassword` refuses (throws this) BEFORE calling the KDF rather than crash;
   * the caller decides how to surface it (see `@lesto/identity` `onUnverifiableHash`).
   */
  | "AUTH_KDF_UNAVAILABLE";

/** Anything authentication can refuse to do. */
export class AuthError extends LestoError<AuthErrorCode> {
  constructor(code: AuthErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "AuthError";
  }
}

/** The minimum acceptable HMAC secret length, in bytes (256 bits of key material). */
export const MIN_SECRET_BYTES = 32;

/**
 * Refuse a signing secret weaker than {@link MIN_SECRET_BYTES} at construction.
 *
 * An HMAC-SHA256 signature is only as strong as its key; a short or empty secret
 * (a placeholder left in, an env var that resolved to "") makes every signed
 * session forgeable. Failing loud at construction turns a silent crypto weakness
 * into a startup error the operator must fix.
 */
export function assertStrongSecret(secret: string): void {
  const bytes = Buffer.byteLength(secret, "utf8");

  if (bytes < MIN_SECRET_BYTES) {
    throw new AuthError(
      "AUTH_WEAK_SECRET",
      `Signing secret is too weak: ${bytes} bytes, need at least ${MIN_SECRET_BYTES}.`,
      { bytes, minBytes: MIN_SECRET_BYTES },
    );
  }
}
