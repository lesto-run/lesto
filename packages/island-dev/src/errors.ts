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
   * The island Fast-Refresh transport could not be stood up — the Vite dev server
   * failed to start (a bound HMR/Vite port, a malformed plugin, a resolve error in the
   * synthesized entry) OR its loopback ports could not be allocated. The underlying
   * throw is carried as `details.cause`. This is THE one island-dev code `lesto dev`
   * DEGRADES on: on it the CLI falls back to the Bun island build/watch/reload path with
   * a logged note (a Vite-transport failure leaves the Bun path unaffected); every OTHER
   * island-dev code is fatal to the dev boot. Only `createIslandDevServer`'s backend
   * start and the CLI's port-allocation wrap (`buildIslandDev`) may mint it.
   */
  | "ISLAND_DEV_SERVER_FAILED";

/** Anything the island dev server can refuse to do. */
export class IslandDevError extends LestoError<IslandDevErrorCode> {
  constructor(code: IslandDevErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "IslandDevError";
  }
}
