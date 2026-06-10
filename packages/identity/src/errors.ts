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
  | "IDENTITY_INVALID_CREDENTIALS"
  | "IDENTITY_EMAIL_NOT_VERIFIED"
  | "IDENTITY_INVALID_TOKEN";

/** Anything the identity layer can refuse to do. */
export class IdentityError extends KeelError<IdentityErrorCode> {
  constructor(code: IdentityErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "IdentityError";
  }
}
