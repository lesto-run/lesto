/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Keel surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type CliErrorCode =
  | "CLI_UNKNOWN_COMMAND"
  | "CLI_CONTENT_MISSING_ARGS"
  | "CLI_UNKNOWN_TARGET"
  | "CLI_ROLLBACK_MISSING_VERSION";

/** Anything the CLI can refuse to do. */
export class CliError extends KeelError<CliErrorCode> {
  constructor(code: CliErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "CliError";
  }
}
