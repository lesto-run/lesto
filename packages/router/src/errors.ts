/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Keel surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type RouterErrorCode =
  | "ROUTER_AMBIGUOUS_SEGMENT"
  | "ROUTER_MALFORMED_PARAM"
  | "ROUTER_MISSING_PARAM";

/** Anything the router can refuse to do. */
export class RouterError extends KeelError<RouterErrorCode> {
  constructor(code: RouterErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "RouterError";
  }
}
