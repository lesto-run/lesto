/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type RouterErrorCode =
  | "ROUTER_AMBIGUOUS_SEGMENT"
  | "ROUTER_MALFORMED_PARAM"
  | "ROUTER_MISSING_PARAM"
  | "ROUTER_FILE_BAD_SEGMENT"
  | "ROUTER_FILE_DUPLICATE_ROUTE"
  | "ROUTER_FILE_DUPLICATE_PARAM";

/** Anything the router can refuse to do. */
export class RouterError extends LestoError<RouterErrorCode> {
  constructor(code: RouterErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "RouterError";
  }
}
