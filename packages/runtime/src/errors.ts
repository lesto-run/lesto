/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Keel surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type RuntimeErrorCode =
  | "RUNTIME_STATIC_PATH_TRAVERSAL"
  /** The request body was not valid JSON for its declared content-type — a 400. */
  | "RUNTIME_INVALID_JSON"
  /** The request body exceeded the configured size limit — a 413. */
  | "RUNTIME_BODY_TOO_LARGE";

/** Anything the transport tier can refuse to do. */
export class RuntimeError extends KeelError<RuntimeErrorCode> {
  constructor(code: RuntimeErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "RuntimeError";
  }
}
