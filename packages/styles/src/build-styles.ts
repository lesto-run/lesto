/**
 * Build an app's stylesheet — the framework-owned CSS pipeline (ADR 0037, Phase 1).
 *
 * Pure orchestration over an injected {@link StyleCompiler} seam: narrate the
 * decision, enforce the size budget, and map every failure to a coded
 * {@link StylesError}. The real Tailwind v4 wiring (`@tailwindcss/node` +
 * `@tailwindcss/oxide` + `node:fs`) lands in a separate coverage-excluded edge
 * (TW2), exactly as `@lesto/assets`'s `buildClient` keeps `Bun.build` in `bun.ts`
 * — so the decision logic here is tested without Tailwind or a disk.
 */

import { LestoError, StylesError } from "./errors";

/**
 * A development (unminified) or production (minified) build.
 *
 * Re-declared rather than imported from `@lesto/assets` (whose `BuildMode` this
 * mirrors): a CSS package should not drag the island-bundler graph (preact,
 * `@lesto/observability`) into its dependencies for one trivial type alias — the
 * same layering discipline ADR 0037 applies to the Tailwind engine itself.
 */
export type BuildMode = "development" | "production";

/** One line of build narration. Mirrors `@lesto/assets`'s `BuildReport`. */
export type BuildReport = (line: string) => void;

/** What to compile and where to put it. */
export interface BuildStylesOptions {
  /** The CSS entry — the Tailwind v4 `@import "tailwindcss"` source file. */
  readonly entry: string;

  /** The directory the compiled stylesheet is written to. */
  readonly outDir: string;

  /** The output file name. Defaults to `styles.css`. */
  readonly outName?: string;

  readonly mode: BuildMode;

  /**
   * The maximum gzipped size, in bytes, the stylesheet may reach before the build
   * fails with `STYLES_BUDGET_EXCEEDED`. Omitted = measure-and-report only, never
   * fail (the size still rides into {@link BuildStylesResult} and the report).
   */
  readonly budgetBytes?: number;

  /**
   * Where the build narrates what it decided — the stylesheet's gzip size and the
   * budget verdict. Defaults to a no-op; the CLI wires `console.log`. A seam, not
   * a global, so the narration is asserted in a test.
   */
  readonly report?: BuildReport;
}

/** What the {@link StyleCompiler} seam is asked to compile. */
export interface CompileRequest {
  readonly entry: string;

  readonly outDir: string;

  readonly outName: string;

  readonly mode: BuildMode;
}

/** What a compile produced — the written path, its gzipped size, and the scanned sources. */
export interface CompiledStyles {
  /** The path the stylesheet was written to. */
  readonly path: string;

  /**
   * The gzipped byte length of the written stylesheet — the report + budget unit
   * (a network-meaningful number; raw bytes mislead since the file ships gzipped).
   */
  readonly gzipBytes: number;

  /** The source files Tailwind scanned — the dev-watch invalidation set. */
  readonly dependencies: readonly string[];
}

/**
 * The injected seam `buildStyles` orchestrates over — the real implementation (the
 * `@tailwindcss/*` engine + `node:fs`) lands in TW2's coverage-excluded edge.
 * `compile` SCANS content, runs Tailwind v4, optimizes, and WRITES the result.
 *
 * A missing entry is the compiler's to detect (it owns the filesystem): it throws
 * a coded `StylesError("STYLES_ENTRY_NOT_FOUND")`, which `buildStyles` propagates
 * unchanged.
 */
export interface StyleCompiler {
  compile(request: CompileRequest): Promise<CompiledStyles>;
}

/** What a style build produced. */
export interface BuildStylesResult {
  readonly path: string;

  readonly gzipBytes: number;

  readonly dependencies: readonly string[];
}

/** The default stylesheet file name when none is given. */
const DEFAULT_OUT_NAME = "styles.css";

/** Human-readable KB to one decimal place — the size unit the report speaks. */
function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** The message of an unknown throw — an `Error`'s `message`, else its string form. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the stylesheet for `options` through the injected `compiler`.
 *
 * Pure: the only effect — compile-scan-optimize-write — is the seam, so the
 * budget verdict, the narration, and the failure mapping are exercised under
 * vitest with a fake. The mapping:
 *
 *   - the compiler throws a coded {@link StylesError} (e.g. `STYLES_ENTRY_NOT_FOUND`
 *     for a missing entry) → propagate it unchanged;
 *   - the compiler throws anything else → wrap as `STYLES_COMPILE_FAILED`, so the
 *     caller always gets a branchable coded error;
 *   - the result is over `budgetBytes` → fail with `STYLES_BUDGET_EXCEEDED`.
 */
export async function buildStyles(
  options: BuildStylesOptions,
  compiler: StyleCompiler,
): Promise<BuildStylesResult> {
  // Narration is opt-in: a no-op unless the caller (the CLI) wires a report sink.
  const report: BuildReport = options.report ?? (() => {});
  const outName = options.outName ?? DEFAULT_OUT_NAME;

  let compiled: CompiledStyles;
  try {
    compiled = await compiler.compile({
      entry: options.entry,
      outDir: options.outDir,
      outName,
      mode: options.mode,
    });
  } catch (error) {
    // Any coded error — a `StylesError` (e.g. the missing-entry contract) or any
    // other `LestoError` the compiler chose to throw — is already branchable, so
    // propagate it with its code intact. Only a non-coded throw is wrapped, so the
    // caller never sees a raw bundler/Tailwind error but a coded code is never lost.
    if (error instanceof LestoError) throw error;

    throw new StylesError(
      "STYLES_COMPILE_FAILED",
      `the style compiler failed: ${messageOf(error)}`,
      { entry: options.entry },
    );
  }

  const budget = options.budgetBytes;
  const overBudget = budget !== undefined && compiled.gzipBytes > budget;

  // Narrate what the build decided (ADR 0011): one line, the gzip size with the
  // budget verdict inline. A no-op `report` by default; the CLI wires `console.log`.
  report(
    `styles  ${outName}  ${kb(compiled.gzipBytes)} gzip${overBudget ? "  — OVER budget" : ""}`,
  );

  // Enforce the budget: a blown size promise FAILS the build rather than shipping
  // silently. Measured on the one stylesheet (there is no split-chunk story here).
  if (budget !== undefined && compiled.gzipBytes > budget) {
    throw new StylesError(
      "STYLES_BUDGET_EXCEEDED",
      `stylesheet "${outName}" is ${kb(compiled.gzipBytes)} gzip, over the ` +
        `${kb(budget)} budget — trim unused layers (a tighter content scan), or raise the budget`,
      { fileName: outName, gzipBytes: compiled.gzipBytes, budgetBytes: budget },
    );
  }

  return {
    path: compiled.path,
    gzipBytes: compiled.gzipBytes,
    dependencies: compiled.dependencies,
  };
}
