/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs, tests,
 * API responses, and the MCP surface branch on the code — never on a message
 * string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type EnvErrorCode = "ENV_VALIDATION_FAILED";

/**
 * Anything the env layer refuses — today, exactly one thing: a schema that did not
 * validate against its source. The thrown message lists EVERY offending variable so
 * a single boot surfaces the whole problem set; callers branch on the `code`.
 */
export class EnvError extends LestoError<EnvErrorCode> {
  constructor(code: EnvErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "EnvError";
  }
}
