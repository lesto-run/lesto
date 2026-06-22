/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs, tests,
 * API responses, and the MCP surface branch on the code — never on a message
 * string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type EnvErrorCode =
  /** The environment did not validate against the schema (one or more bad vars). */
  | "ENV_VALIDATION_FAILED"
  /** A field's `.default(value)` is itself invalid for that field (e.g. a bad port). */
  | "ENV_INVALID_DEFAULT";

/**
 * Anything the env layer refuses: an environment that did not validate against its
 * schema (`ENV_VALIDATION_FAILED` — the message lists EVERY offending variable so a
 * single boot surfaces the whole set), or a schema whose own `.default(value)` is
 * invalid for its field (`ENV_INVALID_DEFAULT`, thrown as the schema is built). Callers
 * branch on the `code`.
 */
export class EnvError extends LestoError<EnvErrorCode> {
  constructor(code: EnvErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "EnvError";
  }
}
