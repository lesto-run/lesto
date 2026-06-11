/**
 * Errors carry codes, not just prose — callers branch on the code.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type AssetsErrorCode =
  /** The bundler produced no entry-point artifact. */
  | "ASSETS_NO_ENTRY"
  /** The bundler reported a failed build. */
  | "ASSETS_BUNDLE_FAILED";

/** Anything the client-asset pipeline can refuse to do. */
export class AssetsError extends KeelError<AssetsErrorCode> {
  constructor(code: AssetsErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "AssetsError";
  }
}
