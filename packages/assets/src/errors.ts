/**
 * Errors carry codes, not just prose — callers branch on the code.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type AssetsErrorCode =
  /** The bundler produced no entry-point artifact. */
  | "ASSETS_NO_ENTRY"
  /** The bundler reported a failed build. */
  | "ASSETS_BUNDLE_FAILED"
  /**
   * A module under `app/islands/` is not a well-formed island: it has no default
   * export, or its default carries no `.island` declaration (i.e. it was not
   * produced by `defineIsland`). The synthesizer cannot classify it eager/lazy or
   * read its name, so the build refuses it by name instead of crashing on an
   * undefined-property read deep in `readIsland`.
   */
  | "ASSETS_BAD_ISLAND_MODULE"
  /**
   * An `ssr: true` island was built for the `preact` client dialect through the
   * CLI, whose server renderer is React — the matched pair (ADR 0008) is broken,
   * so the React server markup would silently mismatch the Preact client on
   * hydration.
   */
  | "ASSETS_DIALECT_SSR_MISMATCH"
  /**
   * The built client entry's gzipped size exceeded the configured budget
   * (`buildClient`'s `budgetBytes`). A budget regression — the ~10 KB Preact
   * island bundle creeping back toward the 118 KB react-dom-server-dragging one —
   * must fail the build loudly, not ship silently (ADR 0011: the build narrates
   * what it decided, and shouts when a size promise is broken).
   */
  | "ASSETS_BUDGET_EXCEEDED";

/** Anything the client-asset pipeline can refuse to do. */
export class AssetsError extends LestoError<AssetsErrorCode> {
  constructor(code: AssetsErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "AssetsError";
  }
}
