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
  | "CLI_ADD_MISSING_INTEGRATION"
  | "CLI_ADD_UNKNOWN_INTEGRATION"
  | "CLI_AGENTS_MARKER_MALFORMED"
  | "CLI_AGENTS_NOTHING_TO_SCAN"
  | "CLI_CLIENT_BUILD_FAILED"
  | "CLI_CONTENT_MISSING_ARGS"
  | "CLI_CONTENT_PACKAGES_MISSING"
  | "CLI_DEPLOY_INCOMPLETE_REMOTE"
  | "CLI_DEPLOY_UNHEALTHY"
  /** The in-preview AI bridge (ADR 0033 Inc 3) refused a turn: its tool is not on the positive read-only allowlist, or the dev MCP seam is not wired — inspect-only, fail-closed. */
  | "CLI_DEV_MCP_UNAVAILABLE"
  /** A dev-only surface (live reload, island Fast Refresh, or the loopback MCP plane) was wired on a non-`dev` command (ADR 0032 Inc 5). */
  | "CLI_DEV_SURFACE_IN_PRODUCTION"
  /** The project's `env.client.ts` EXISTS but exports no `clientEnv` schema — a misauthored client-env module. Refused loud + coded here (not silently skipped) so a missing export never ships an island with unreplaced `PUBLIC_*` references. */
  | "CLI_ENV_CLIENT_NO_EXPORT"
  /** PREVIEW `lesto eval` gate: one or more of the app's declared evals failed (`details` carries the failed/total counts). */
  | "CLI_EVAL_FAILED"
  | "CLI_GENERATE_BAD_FIELD"
  | "CLI_GENERATE_BAD_NAME"
  | "CLI_GENERATE_BAD_ROUTE"
  | "CLI_GENERATE_MISSING_ARGS"
  | "CLI_GENERATE_UNKNOWN_GENERATOR"
  /** `lesto build` selected 2+ static sites that share the project's one island/CSS bundle: each is served from its own `out/<name>/`, so the shared client/styles would be orphaned. Build each with `--target <name>` until per-site placement is designed. */
  | "CLI_MULTI_STATIC_ASSETS_UNSUPPORTED"
  | "CLI_ROLLBACK_MISSING_VERSION"
  | "CLI_STYLES_BUILD_FAILED"
  | "CLI_UNKNOWN_COMMAND"
  | "CLI_UNKNOWN_TARGET";

/** Anything the CLI can refuse to do. */
export class CliError extends LestoError<CliErrorCode> {
  constructor(code: CliErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "CliError";
  }
}
