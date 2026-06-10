/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Keel surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type WebErrorCode =
  | "WEB_UNKNOWN_CONTROLLER"
  | "WEB_UNKNOWN_ACTION"
  | "WEB_VALIDATION_FAILED";

/** Anything the web dispatch core can refuse to do. */
export class WebError extends KeelError<WebErrorCode> {
  constructor(code: WebErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "WebError";
  }
}
