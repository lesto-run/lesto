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
  | "UI_CLIENT_COMPONENT_MISSING"
  // Temporary (item 1 of the island-data-hardening plan): refuses `ssr: true` +
  // `data` at define time, because the server cannot yet render an island WITH
  // its bound data. Item 7 (ADR 0012's render-time resolver) makes that the
  // canonical island and REMOVES this code, replacing it with an emission-time
  // check (`UI_ISLAND_SSR_DATA_UNRESOLVED`) where topology is actually known.
  | "UI_CLIENT_SSR_DATA_UNSUPPORTED"
  | "UI_CLIENT_SSR_NEEDS_COMPONENT"
  | "UI_INVALID_DATA_SOURCE_NAME"
  | "UI_INVALID_ENUM_SPEC"
  | "UI_ISLAND_PROPS_NOT_SERIALIZABLE"
  | "UI_ISLAND_UNKNOWN_COMPONENT"
  | "UI_STREAM_INCOMPLETE"
  | "UI_STREAM_TIMEOUT";

/** Anything the UI engine can refuse to do while building a schema. */
export class UiError extends KeelError<UiErrorCode> {
  constructor(code: UiErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "UiError";
  }
}
