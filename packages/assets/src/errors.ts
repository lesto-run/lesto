/**
 * Errors carry codes, not just prose — callers branch on the code.
 */

import { KeelError } from "@keel/errors";

export { KeelError };

export type AssetsErrorCode =
  /** The bundler produced no entry-point artifact. */
  | "ASSETS_NO_ENTRY"
  /** The bundler reported a failed build. */
  | "ASSETS_BUNDLE_FAILED"
  /**
   * An `ssr: true` island was built for the `preact` client dialect through the
   * CLI, whose server renderer is React — the matched pair (ADR 0008) is broken,
   * so the React server markup would silently mismatch the Preact client on
   * hydration.
   */
  | "ASSETS_DIALECT_SSR_MISMATCH";

/** Anything the client-asset pipeline can refuse to do. */
export class AssetsError extends KeelError<AssetsErrorCode> {
  constructor(code: AssetsErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "AssetsError";
  }
}
