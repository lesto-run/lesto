/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Volo surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { VoloError } from "@volo/errors";

export { VoloError };

export type RouterErrorCode =
  | "ROUTER_AMBIGUOUS_SEGMENT"
  | "ROUTER_MALFORMED_PARAM"
  | "ROUTER_MISSING_PARAM";

/** Anything the router can refuse to do. */
export class RouterError extends VoloError<RouterErrorCode> {
  constructor(code: RouterErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "RouterError";
  }
}
