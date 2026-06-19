/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type WebErrorCode =
  | "WEB_DIALECT_MISMATCH"
  | "WEB_UNKNOWN_DATA_SOURCE"
  | "WEB_VALIDATION_FAILED"
  | "WEB_BAD_RENDER_DEADLINE"
  | "WEB_CLIENT_ERROR_BODY_TOO_LARGE"
  | "WEB_BROWSER_SPANS_BODY_TOO_LARGE"
  | "WEB_FILE_ROUTE_MODULE_MISSING";

/** Anything the web dispatch core can refuse to do. */
export class WebError extends LestoError<WebErrorCode> {
  constructor(code: WebErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "WebError";
  }
}
