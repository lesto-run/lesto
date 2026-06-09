/**
 * Errors carry codes, not just prose.
 *
 * Every failure surfaces a stable, machine-readable `code`. Callers branch on
 * the code — never on a message string, which is free to change for humans
 * without breaking machines.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type FormErrorCode = "FORM_INVALID";

/** A submission the form refuses to accept. */
export class FormError extends KeelError<FormErrorCode> {
  constructor(code: FormErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "FormError";
  }
}
