/**
 * The Vite dialect config shared by the PROD island build (`@lesto/assets`'s
 * `vite-build.ts`) and the DEV island server (`@lesto/island-dev`'s `config.ts`).
 *
 * Both compute the SAME two things from the SAME {@link PREACT_ALIAS} map: the preact
 * dialect's anchored `resolve.alias` and the per-dialect `{ dedupe, include }` runtime
 * deps. They MUST never diverge — a dev/prod split in how `react` is rewritten, or in
 * which runtime is deduped to one copy, is exactly the hard-to-spot footgun this package
 * exists to prevent (a second React/Preact instance breaks hooks). So the derivation
 * lives here once and both bundlers consume it.
 *
 * Deliberately NARROW + Vite-free. `preactAliases()` returns the structural
 * `{ find: RegExp; replacement: string }` shape, NOT Vite's `Alias` — that shape is
 * assignable to BOTH Vite's `Alias` (in `vite-build.ts`, the bundler edge) AND
 * island-dev's own `ViteIslandAlias`. This module MUST NOT import from `"vite"`:
 * island-dev's `config.ts` is a coverage-COVERED module that deliberately keeps Vite's
 * sprawling types out (they live only in its excluded `vite.ts` edge), and this module
 * is on its import path. Keeping it Vite-free is what lets the dev config stay covered.
 *
 * Pure data over the dialect — no bundler, no filesystem — so the alias set and the
 * dedupe/include lists are asserted directly under vitest (`vite-alias.test.ts`), the
 * same way {@link PREACT_ALIAS} is kept apart from the resolver that applies it.
 */

import type { Dialect } from "./build-client";
import { PREACT_ALIAS } from "./preact-alias";

/**
 * One anchored module-resolution alias — the narrow shape shared by both bundlers.
 *
 * Structurally assignable to Vite's `Alias` (the prod build) and to island-dev's
 * `ViteIslandAlias` (the dev server), so neither side has to import the other's type.
 */
export interface DialectAlias {
  /** The anchored (`^…$`) specifier matcher, e.g. `/^react$/`. */
  readonly find: RegExp;

  /** The target the matched specifier resolves to, e.g. `preact/compat`. */
  readonly replacement: string;
}

/** The dialect's runtime `dedupe` + optimize-`include` lists. */
export interface DialectRuntimeDeps {
  /**
   * The packages forced to ONE copy across the app and the symlinked workspace
   * `@lesto/ui`. A second React/Preact instance breaks hooks (and, in dev, Fast
   * Refresh) — this is the matched duplicate-runtime guard both bundlers apply.
   */
  readonly dedupe: string[];

  /**
   * The dialect's client runtime to pre-bundle, so Vite optimizes it ONCE rather than
   * re-discovering it on the first island request. Same packages as `dedupe`, expanded
   * to the specific entry points an island graph reaches.
   */
  readonly include: string[];
}

/** Escape a string so it matches literally inside a `new RegExp(...)`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * The preact dialect's resolve aliases: each `react*` specifier anchored (`^…$`) to
 * its `preact/compat` target, so `react` is rewritten WITHOUT also catching `react-dom`.
 * The matched sibling of `bun.ts`'s `preactAliasPlugin` (the same map as an `onResolve`
 * plugin) — derived from {@link PREACT_ALIAS} so all three bundler paths agree.
 *
 * Returns the narrow {@link DialectAlias} shape (not Vite's `Alias`) so this module
 * stays Vite-free; the prod build assigns it straight into `resolve.alias`, and the dev
 * server spreads it into its `ViteIslandAlias[]`. The caller applies this only for the
 * `preact` dialect; `react` needs no alias (its specifiers are already the real runtime).
 */
export function preactAliases(): readonly DialectAlias[] {
  return Object.entries(PREACT_ALIAS).map(([from, to]) => ({
    find: new RegExp(`^${escapeRegExp(from)}$`),
    replacement: to,
  }));
}

/**
 * The dialect's client runtime as `{ dedupe, include }` — the duplicate-runtime guard
 * plus the pre-bundle set, shared by the dev server and the prod build.
 *
 * For `preact` the runtime named is preact's own: the `react` specifiers are aliased to
 * `preact/compat` BEFORE optimization (see {@link preactAliases}), so it is `preact*` that
 * gets deduped/pre-bundled, never React. For `react`, both `react` and `react-dom` are
 * deduped; `include` lists `react/jsx-dev-runtime` (NOT just `jsx-runtime`) because that
 * is the automatic runtime Vite emits in DEV (`jsxDEV`) — without it the first island
 * request triggers a re-optimize.
 *
 * Both fields are plain (mutable) `string[]` because Vite's `dedupe` and
 * `DepOptimizationOptions.include` are mutable: the lists spread straight into the real
 * `InlineConfig` on both sides.
 */
export function dialectRuntimeDeps(dialect: Dialect): DialectRuntimeDeps {
  return dialect === "preact"
    ? {
        dedupe: ["preact"],
        include: ["preact", "preact/compat", "preact/hooks", "preact/jsx-runtime"],
      }
    : {
        dedupe: ["react", "react-dom"],
        include: [
          "react",
          "react-dom",
          "react-dom/client",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
        ],
      };
}
