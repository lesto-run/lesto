/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type CliErrorCode =
  | "CLI_AGENTS_MARKER_MALFORMED"
  | "CLI_AGENTS_NOTHING_TO_SCAN"
  | "CLI_CLIENT_BUILD_FAILED"
  | "CLI_CONTENT_MISSING_ARGS"
  | "CLI_CONTENT_PACKAGES_MISSING"
  | "CLI_DEPLOY_INCOMPLETE_REMOTE"
  | "CLI_DEPLOY_UNHEALTHY"
  | "CLI_GENERATE_BAD_FIELD"
  | "CLI_GENERATE_BAD_NAME"
  | "CLI_GENERATE_BAD_ROUTE"
  | "CLI_GENERATE_MISSING_ARGS"
  | "CLI_GENERATE_UNKNOWN_GENERATOR"
  | "CLI_ROLLBACK_MISSING_VERSION"
  | "CLI_UNKNOWN_COMMAND"
  | "CLI_UNKNOWN_TARGET";

/** Anything the CLI can refuse to do. */
export class CliError extends LestoError<CliErrorCode> {
  constructor(code: CliErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "CliError";
  }
}
