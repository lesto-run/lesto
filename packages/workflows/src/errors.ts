/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Volo surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { VoloError } from "@volo/errors";

export { VoloError };

export type WorkflowErrorCode = "WORKFLOW_UNKNOWN";

/** Anything the workflow engine can refuse to do. */
export class WorkflowError extends VoloError<WorkflowErrorCode> {
  constructor(code: WorkflowErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "WorkflowError";
  }
}
