/**
 * Errors carry codes, not just prose.
 *
 * Every failure surfaces a stable, machine-readable `code`. Callers branch on
 * the code — never on a message string, which is free to change for humans
 * without breaking machines.
 */

import { VoloError } from "@volo/errors";

/** Anything UI generation can refuse to produce. */
export type GenerateErrorCode = "GENERATE_NO_OUTPUT";

/** A failure while generating a UI tree from a model. */
export class GenerateError extends VoloError<GenerateErrorCode> {
  constructor(code: GenerateErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "GenerateError";
  }
}
