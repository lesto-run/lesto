/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Keel surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { KeelError } from "@keel/errors";

/** Stable codes for every failure the deploy planner and shipper can raise. */
export type DeployErrorCode =
  /** A target named a site that is absent from the build manifest / site set. */
  | "DEPLOY_UNKNOWN_SITE"
  /** A file would be published outside the dist root (path traversal). */
  | "DEPLOY_PATH_ESCAPE"
  /** A release version is not a single, safe path segment. */
  | "DEPLOY_BAD_VERSION"
  /** A staged release failed its pre-flip health gate; the pointer did not move. */
  | "DEPLOY_RELEASE_UNHEALTHY"
  /** A rollback named a version that was never published. */
  | "DEPLOY_UNKNOWN_RELEASE";

/** Anything the deploy layer can refuse to do, coded for machines. */
export class DeployError extends KeelError<DeployErrorCode> {
  constructor(code: DeployErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "DeployError";
  }
}
