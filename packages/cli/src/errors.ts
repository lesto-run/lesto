/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Volo surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { VoloError } from "@volo/errors";

export { VoloError };

export type CliErrorCode =
  | "CLI_CLIENT_BUILD_FAILED"
  | "CLI_CONTENT_MISSING_ARGS"
  | "CLI_DEPLOY_INCOMPLETE_REMOTE"
  | "CLI_DEPLOY_UNHEALTHY"
  | "CLI_ROLLBACK_MISSING_VERSION"
  | "CLI_UNKNOWN_COMMAND"
  | "CLI_UNKNOWN_TARGET";

/** Anything the CLI can refuse to do. */
export class CliError extends VoloError<CliErrorCode> {
  constructor(code: CliErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "CliError";
  }
}
