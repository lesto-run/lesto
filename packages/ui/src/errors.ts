/**
 * Errors carry codes, not just prose.
 *
 * Every failure surfaces a stable, machine-readable `code`. Callers branch on
 * the code — never on a message string, which is free to change for humans
 * without breaking machines.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type UiErrorCode =
  | "UI_INVALID_ENUM_SPEC"
  | "UI_ISLAND_PROPS_NOT_SERIALIZABLE"
  | "UI_ISLAND_UNKNOWN_COMPONENT";

/** Anything the UI engine can refuse to do while building a schema. */
export class UiError extends KeelError<UiErrorCode> {
  constructor(code: UiErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "UiError";
  }
}
