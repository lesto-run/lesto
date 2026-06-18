/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Volo surfaces a stable, machine-readable `code`. Logs, tests,
 * and the CLI's exit path branch on the code — never on a message string, which
 * is free to change for humans without breaking machines.
 */

import { VoloError } from "@volo/errors";

export { VoloError };

export type CreateVoloErrorCode = "CREATE_VOLO_TARGET_EXISTS";

/** Anything the scaffolder can refuse to do. */
export class CreateVoloError extends VoloError<CreateVoloErrorCode> {
  constructor(code: CreateVoloErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "CreateVoloError";
  }
}
