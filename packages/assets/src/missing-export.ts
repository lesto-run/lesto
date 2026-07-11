/**
 * `failOnMissingExport` — turns a Rollup `MISSING_EXPORT` build warning into a
 * FATAL, coded `AssetsError` for the prod Vite build (`vite-build.ts`), scoped to
 * misses written in FIRST-PARTY code.
 *
 * Rollup classifies a namespace-member read of a name a module does not export
 * (`ns.typo`, or an unreferenced `import { typo }`) as a NON-FATAL `MISSING_EXPORT`
 * warning and compiles the access to a literal `undefined` at runtime — exactly
 * how `Bun.build` ships the same code. Vite's default `onLog`/`onwarn` only WARNS
 * `MISSING_EXPORT` (only `UNRESOLVED_IMPORT` throws), so before this escalation a
 * genuine user typo shipped to prod silently as `undefined`.
 *
 * WHY SCOPE ON THE IMPORTER. A blanket escalation (every `MISSING_EXPORT` fatal)
 * also kills a build over a THIRD-PARTY dependency's deliberate guarded-optional
 * access — `React.useSyncExternalStore ?? shim`, `if (React.use) …`, `ns.maybe ??
 * fallback` — code that handles the `undefined` correctly at runtime. That is most
 * acute under the preact dialect (`preact/compat` is a strict subset of React —
 * no `use`/`useOptimistic`/`useActionState`/`cache`). So the escalation fires only
 * when the miss was written in the app's OWN source; a miss whose importer lives
 * under `node_modules` is a dependency's business and stays a plain warning.
 *
 * The discriminant is the IMPORTER (`warning.id` — the module doing the access),
 * NOT the exporter. A user's genuine typo against a `node_modules` package
 * (`app/islands/Foo.tsx` → `import * as UI from "@lesto/ui"; UI.typo`) has a
 * `node_modules` EXPORTER but a first-party IMPORTER, and MUST stay fatal — else
 * every typo against a dependency (the common case) would ship as `undefined`
 * again, defeating the escalation. When the importer cannot be identified
 * (`warning.id` absent), it stays fatal: we downgrade only when we can POSITIVELY
 * confirm third-party authorship.
 *
 * Extracted out of the coverage-excluded bundler edge (`vite-build.ts`) so the
 * throw/downgrade decision is unit-tested directly, the same reason
 * `collect-artifacts.ts` exists. `warning.binding` (the missing name),
 * `warning.exporter` (the RESOLVED absolute id of the module lacking the name),
 * and `warning.id` (the RESOLVED absolute id of the importer) are all real,
 * populated fields on rollup@4's `RollupLog` for this code — confirmed against a
 * real warning object, not just the `.d.ts` — so the thrown error names exactly
 * which binding missed from which module, and the scope decision is real.
 */

import type { Rollup } from "vite";

import { AssetsError } from "./errors";

/**
 * A resolved module id that lives under a `node_modules` directory — i.e. code
 * the app depends on, not code the app authored. `/node_modules/` (slash-bounded)
 * avoids matching a source dir that merely contains the substring; Rollup ids are
 * `/`-normalised, but the backslash arm keeps it correct on Windows-style ids.
 */
function isThirdPartyModule(id: string | undefined): boolean {
  return id !== undefined && /[\\/]node_modules[\\/]/.test(id);
}

/**
 * THROW a fatal `AssetsError` when `warning` is a Rollup `MISSING_EXPORT` written
 * in FIRST-PARTY code — a `ns.missing` namespace-member miss Rollup would
 * otherwise only warn about and compile to `undefined`. A miss whose importer
 * lives under `node_modules` (a dependency's deliberate guarded-optional access)
 * and every non-`MISSING_EXPORT` code return untouched, so `vite-build.ts`
 * forwards them to Rollup's `defaultHandler` unchanged (a plain warning).
 *
 * The thrown error carries the missing `binding` + `exporter` module id (in both
 * the message and `details`) so the build failure names the exact typo. It rides
 * out of Rollup's build; `vite-build.ts` re-throws THIS coded error unflattened
 * (its `console.error`s this cause first), so the user — and a programmatic
 * `buildClient` consumer — sees which binding/module missed instead of a silent
 * `undefined` or a generic bundle failure.
 *
 * Deliberately DIVERGES from `Bun.build`, which ships the same access as a silent
 * `undefined` — that silence is the bug, not a parity target.
 */
export function failOnMissingExport(warning: Rollup.RollupLog): void {
  if (warning.code !== "MISSING_EXPORT") return;

  // A miss authored inside a dependency is that dependency's concern (often a
  // deliberate optional-feature probe) — leave it a plain warning. Only the app's
  // OWN misses are typos worth failing the build over. Unknown importer ⇒ fatal.
  if (isThirdPartyModule(warning.id)) return;

  throw new AssetsError(
    "ASSETS_MISSING_EXPORT",
    `missing export ${JSON.stringify(warning.binding)} from ${JSON.stringify(warning.exporter)} — ` +
      "a namespace-member access of a name the module does not export would ship as `undefined`; " +
      "check the import or access for a typo",
    { binding: warning.binding, exporter: warning.exporter, importer: warning.id },
  );
}
