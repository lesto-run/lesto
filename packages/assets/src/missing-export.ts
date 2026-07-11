/**
 * Classifies a Rollup `MISSING_EXPORT` warning so the prod Vite build (`vite-build.ts`)
 * can swallow ONLY the one contained hack it exists to paper over, instead of the
 * blanket "swallow every `MISSING_EXPORT`" that used to also hide a user's genuine typo
 * (an `import { typo } from "..."` or a `ns.typo` namespace-member read of a name that
 * doesn't exist) — which Rollup ALSO reports as a non-fatal `MISSING_EXPORT` warning and
 * compiles to a literal `undefined`, exactly like the contained case, so a blanket
 * swallow could not tell the two apart.
 *
 * The contained case is `@lesto/ui`'s `define-island.tsx` reading `React.use` off the
 * React namespace (a namespace-member access, not a named import) — under the preact
 * dialect's `react → preact/compat` alias (ADR 0007), `preact/compat` exports no `use`;
 * it is only ever CALLED server-side, where React is real (see `define-island.tsx`'s own
 * doc). Extracted here (out of the coverage-excluded bundler edge) so the classification
 * is unit-tested directly, the same reason `collect-artifacts.ts` exists.
 *
 * Confirmed against a real warning object (not just the `.d.ts`): building a throwaway
 * entry with `import * as React from "preact/compat"; React.use` and logging the
 * `onwarn` argument yields
 * `{ binding: "use", code: "MISSING_EXPORT", exporter: "<abs path>/preact/compat/dist/compat.module.js", ... }`
 * — matching rollup@4's shipped `RollupLog` type (`binding`/`exporter` are both real,
 * populated fields, per its `logMissingExport` source) and the same shape Rollup uses for
 * ANY namespace-member miss, contained or not: a throwaway repro of
 * `import * as mod from "./mod"; mod.typo` (where `mod` has no `typo` export) produced
 * `{ binding: "typo", code: "MISSING_EXPORT", exporter: "<abs path>/mod.mjs" }` through the
 * exact same `onwarn` hook — proving `binding` + `exporter` are what distinguish the
 * contained hack from a real typo of the same shape.
 *
 * `exporter` is Rollup's RESOLVED absolute module id (later rendered relative for the
 * warning's own message), not a bare specifier — so matching on the `preact/compat`
 * package subpath (present in the resolved path regardless of which conditional export,
 * `.mjs`/`.js`/`.module.js`, was resolved) identifies the module without caring where
 * `node_modules` is rooted.
 */

import type { Rollup } from "vite";

/** The one missing binding the contained hack ever produces (`define-island.tsx`). */
const CONTAINED_BINDING = "use";

/** Matches `exporter` paths resolving into the `preact/compat` package subpath. */
const PREACT_COMPAT_EXPORTER = /(?:^|[/\\])preact[/\\]compat(?:[/\\]|$)/;

/**
 * True iff `warning` is EXACTLY the contained `React.use`-off-`preact/compat` case — the
 * only `MISSING_EXPORT` the prod build may swallow. Every other warning (a different
 * `code` entirely, a different `binding`, or a `binding: "use"` whose `exporter` is NOT
 * `preact/compat`) is a real miss and must escalate to `defaultHandler`.
 */
export function shouldSwallowMissingExport(warning: Rollup.RollupLog): boolean {
  return (
    warning.code === "MISSING_EXPORT" &&
    warning.binding === CONTAINED_BINDING &&
    warning.exporter !== undefined &&
    PREACT_COMPAT_EXPORTER.test(warning.exporter)
  );
}
