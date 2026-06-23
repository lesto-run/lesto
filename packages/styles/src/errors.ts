/**
 * Errors carry codes, not just prose — callers branch on the code.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type StylesErrorCode =
  /**
   * The CSS entry file does not exist. Detected by the {@link StyleCompiler}
   * (which owns the filesystem) and propagated unchanged by `buildStyles`, so a
   * misconfigured `ui.css` fails the build by name instead of producing an empty
   * stylesheet.
   */
  | "STYLES_ENTRY_NOT_FOUND"
  /**
   * The Tailwind v4 compile failed (a malformed `@import`, an invalid `@theme`, a
   * source-scan error). Any non-coded throw from the compiler is wrapped in this
   * code so the caller always gets a branchable failure.
   */
  | "STYLES_COMPILE_FAILED"
  /**
   * The compiled stylesheet's gzipped size exceeded the configured budget
   * (`buildStyles`'s `budgetBytes`) — a size regression that must fail the build
   * loudly rather than ship silently (ADR 0011: the build narrates what it
   * decided, and shouts when a size promise is broken).
   */
  | "STYLES_BUDGET_EXCEEDED";

/** Anything the CSS build pipeline can refuse to do. */
export class StylesError extends LestoError<StylesErrorCode> {
  constructor(code: StylesErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "StylesError";
  }
}
