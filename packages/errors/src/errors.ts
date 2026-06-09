/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Keel surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

/** The root of every Keel error. Generic over its code union for exhaustiveness. */
export class KeelError<Code extends string = string> extends Error {
  readonly code: Code;

  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: Code, message: string, details: Record<string, unknown> = {}) {
    super(message);

    this.name = "KeelError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/** True iff `value` is a `KeelError` (or a subclass of one). */
export function isKeelError(value: unknown): value is KeelError {
  return value instanceof KeelError;
}

/** True iff `value` is a `KeelError` whose code matches exactly. */
export function hasCode(value: unknown, code: string): boolean {
  return isKeelError(value) && value.code === code;
}
