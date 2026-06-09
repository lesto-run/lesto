/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Keel surfaces a stable, machine-readable `code`. Logs, tests,
 * and the CLI's exit path branch on the code — never on a message string, which
 * is free to change for humans without breaking machines.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type CreateKeelErrorCode = "CREATE_KEEL_TARGET_EXISTS";

/** Anything the scaffolder can refuse to do. */
export class CreateKeelError extends KeelError<CreateKeelErrorCode> {
  constructor(code: CreateKeelErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "CreateKeelError";
  }
}
