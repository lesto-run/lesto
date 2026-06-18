/**
 * Errors carry codes, not just prose.
 *
 * Every failure surfaces a stable, machine-readable `code`. Callers branch on
 * the code — never on a message string, which is free to change for humans
 * without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type UiErrorCode =
  | "UI_CLIENT_COMPONENT_MISSING"
  | "UI_CLIENT_SSR_NEEDS_COMPONENT"
  | "UI_INVALID_DATA_SOURCE_NAME"
  | "UI_INVALID_ENUM_SPEC"
  | "UI_ISLAND_DATA_FETCH_FAILED"
  | "UI_ISLAND_DATA_TIMEOUT"
  | "UI_ISLAND_PROPS_NOT_SERIALIZABLE"
  | "UI_ISLAND_SSR_DATA_UNRESOLVED"
  | "UI_ISLAND_UNKNOWN_COMPONENT"
  | "UI_STREAM_INCOMPLETE"
  | "UI_STREAM_TIMEOUT";

/** Anything the UI engine can refuse to do while building a schema. */
export class UiError extends LestoError<UiErrorCode> {
  constructor(code: UiErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "UiError";
  }
}
