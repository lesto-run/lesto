/**
 * `failOnMissingExport` — turns a Rollup `MISSING_EXPORT` build warning into a
 * FATAL, coded `AssetsError` for the prod Vite build (`vite-build.ts`).
 *
 * Rollup classifies a namespace-member read of a name a module does not export
 * (`ns.typo`, or an unreferenced `import { typo }`) as a NON-FATAL `MISSING_EXPORT`
 * warning and compiles the access to a literal `undefined` at runtime — exactly
 * how `Bun.build` ships the same code. Vite's default `onLog`/`onwarn` only WARNS
 * `MISSING_EXPORT` (only `UNRESOLVED_IMPORT` throws), so before this escalation a
 * genuine user typo shipped to prod silently as `undefined`.
 *
 * There is no longer any legitimate producer to contain. The one historical live
 * case — `@lesto/ui`'s `define-island.tsx` reading `React.use` off the
 * `react → preact/compat` namespace under the preact dialect (`preact/compat`
 * exports no `use`) — is gone: the resolver now carries React's `use` through a
 * server-only seam (`@lesto/web` builds it, `defineIsland` calls `resolver.use`),
 * so no `react` specifier rides the client island graph and nothing reads `use`
 * off the aliased namespace. Every `MISSING_EXPORT` that now reaches the build is
 * a real miss, so this escalates ALL of them (superseding the earlier narrowed
 * `shouldSwallowMissingExport` swallow, whose one contained shape no longer
 * exists).
 *
 * Extracted out of the coverage-excluded bundler edge (`vite-build.ts`) so the
 * escalation is unit-tested directly, the same reason `collect-artifacts.ts`
 * exists. `warning.binding` (the missing name) and `warning.exporter` (Rollup's
 * RESOLVED absolute module id) are both real, populated fields on rollup@4's
 * `RollupLog` for this code — confirmed against a real warning object, not just
 * the `.d.ts` — so the thrown error names exactly which binding missed from which
 * module.
 */

import type { Rollup } from "vite";

import { AssetsError } from "./errors";

/**
 * THROW a fatal `AssetsError` when `warning` is a Rollup `MISSING_EXPORT` — a
 * `ns.missing` namespace-member miss Rollup would otherwise only warn about and
 * compile to `undefined`. Every other warning code returns untouched, so
 * `vite-build.ts` forwards it to Rollup's `defaultHandler` unchanged.
 *
 * The thrown error carries the missing `binding` + `exporter` module id (in both
 * the message and `details`) so the build failure names the exact typo. It rides
 * out of Rollup's build and is caught + re-wrapped as `ASSETS_BUNDLE_FAILED` by
 * `vite-build.ts` (which `console.error`s this cause first), so the user sees
 * which binding/module missed instead of a silent `undefined`.
 *
 * Deliberately DIVERGES from `Bun.build`, which ships the same access as a silent
 * `undefined` — that silence is the bug, not a parity target.
 */
export function failOnMissingExport(warning: Rollup.RollupLog): void {
  if (warning.code !== "MISSING_EXPORT") return;

  throw new AssetsError(
    "ASSETS_BUNDLE_FAILED",
    `missing export ${JSON.stringify(warning.binding)} from ${JSON.stringify(warning.exporter)} — ` +
      "a namespace-member access of a name the module does not export would ship as `undefined`; " +
      "check the import or access for a typo",
    { binding: warning.binding, exporter: warning.exporter },
  );
}
