/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Volo surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

/** The root of every Volo error. Generic over its code union for exhaustiveness. */
export class VoloError<Code extends string = string> extends Error {
  readonly code: Code;

  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: Code, message: string, details: Record<string, unknown> = {}) {
    super(message);

    this.name = "VoloError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/** True iff `value` is a `VoloError` (or a subclass of one). */
export function isVoloError(value: unknown): value is VoloError {
  return value instanceof VoloError;
}

/** True iff `value` is a `VoloError` whose code matches exactly. */
export function hasCode(value: unknown, code: string): boolean {
  return isVoloError(value) && value.code === code;
}
