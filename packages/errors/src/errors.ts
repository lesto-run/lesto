/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

/** The root of every Lesto error. Generic over its code union for exhaustiveness. */
export class LestoError<Code extends string = string> extends Error {
  readonly code: Code;

  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: Code, message: string, details: Record<string, unknown> = {}) {
    super(message);

    this.name = "LestoError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/** True iff `value` is a `LestoError` (or a subclass of one). */
export function isLestoError(value: unknown): value is LestoError {
  return value instanceof LestoError;
}

/** True iff `value` is a `LestoError` whose code matches exactly. */
export function hasCode(value: unknown, code: string): boolean {
  return isLestoError(value) && value.code === code;
}
