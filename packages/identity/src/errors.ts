/**
 * Errors carry codes, not just prose.
 *
 * Every failure in identity surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type IdentityErrorCode =
  | "IDENTITY_EMAIL_TAKEN"
  | "IDENTITY_INVALID_EMAIL"
  | "IDENTITY_WEAK_PASSWORD"
  | "IDENTITY_WEAK_SECRET"
  | "IDENTITY_INVALID_CREDENTIALS"
  | "IDENTITY_EMAIL_NOT_VERIFIED"
  | "IDENTITY_LOGIN_THROTTLED"
  | "IDENTITY_INVALID_TOKEN";

/** Anything the identity layer can refuse to do. */
export class IdentityError extends KeelError<IdentityErrorCode> {
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
