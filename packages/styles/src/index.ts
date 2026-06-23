/**
 * @lesto/styles — the framework-owned CSS build pipeline (ADR 0037, Phase 1).
 *
 *   const css = await buildStyles(
 *     { entry: "app/styles.css", outDir: "out", mode: "production" },
 *     tailwindStyleCompiler(projectRoot), // TW2's real @tailwindcss/* edge
 *   );
 *
 * Compiles a Tailwind v4 entry to a served stylesheet — so an app ships a built
 * `/styles.css` with no bespoke build script. `buildStyles` is pure orchestration
 * over an injected {@link StyleCompiler}; the real `@tailwindcss/node` +
 * `@tailwindcss/oxide` + filesystem wiring is a separate coverage-excluded edge.
 */

export { buildStyles } from "./build-styles";
export type {
  BuildMode,
  BuildReport,
  BuildStylesOptions,
  BuildStylesResult,
  CompiledStyles,
  CompileRequest,
  StyleCompiler,
} from "./build-styles";

export { LestoError, StylesError } from "./errors";
export type { StylesErrorCode } from "./errors";
