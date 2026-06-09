/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Keel surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type RbacErrorCode = "RBAC_UNKNOWN_ROLE";

/** Anything authorization can refuse to answer. */
export class RbacError extends KeelError<RbacErrorCode> {
  constructor(code: RbacErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "RbacError";
  }
}
