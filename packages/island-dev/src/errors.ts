/**
 * Errors carry codes, not just prose — callers branch on the code.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type IslandDevErrorCode =
  /**
   * The configured `ui.dialect` is neither `react` nor `preact`, so no Fast-Refresh
   * plugin pair (ADR 0008) can be selected. Refused by name instead of silently
   * standing up a dev server with no module-level HMR.
   */
  | "ISLAND_DEV_UNKNOWN_DIALECT"
  /**
   * The Vite dev server failed to start (a bound HMR port, a malformed plugin, a
   * resolve error in the synthesized entry). The underlying Vite throw is carried as
   * `details.cause` so the CLI can paint it in the dev overlay rather than crash the
   * boot.
   */
  | "ISLAND_DEV_SERVER_FAILED";

/** Anything the island dev server can refuse to do. */
export class IslandDevError extends LestoError<IslandDevErrorCode> {
  constructor(code: IslandDevErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "IslandDevError";
  }
}
