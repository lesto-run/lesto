/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs, tests,
 * and the CLI's exit path branch on the code — never on a message string, which
 * is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type CreateLestoErrorCode = "CREATE_LESTO_TARGET_EXISTS";

/** Anything the scaffolder can refuse to do. */
export class CreateLestoError extends LestoError<CreateLestoErrorCode> {
  constructor(code: CreateLestoErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "CreateLestoError";
  }
}
