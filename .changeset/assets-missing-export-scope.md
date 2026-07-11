---
"@lesto/assets": patch
---

Scope the fatal `MISSING_EXPORT` build escalation to FIRST-PARTY code, and give it its own preserved error code.

The escalation that makes a genuine `ns.typo` fail the build (rather than ship as `undefined`) previously fired for **every** `MISSING_EXPORT` — including a `node_modules` dependency's deliberate guarded-optional namespace access (`React.useSyncExternalStore ?? shim`, `ns.maybe ?? fallback`), which handles the `undefined` at runtime. That is most acute under the preact dialect, where `preact/compat` is a strict subset of React (no `use`/`useOptimistic`/`useActionState`/`cache`), and would fail an app build over a dependency's feature-probe.

`failOnMissingExport` now throws only when the miss was authored in first-party source, keyed on the **importer** (`warning.id` — the module doing the access), not the exporter. This is the correct axis: a user's own typo against a `node_modules` package (`app/islands/Foo.tsx` → `import * as UI from "@lesto/ui"; UI.typo`) has a `node_modules` *exporter* but a first-party *importer*, and stays fatal — scoping on the exporter would silently re-ship every typo-against-a-dependency as `undefined`. A miss whose importer lives under `node_modules` is left a plain warning (forwarded to `defaultHandler`); when the importer can't be identified, it stays fatal (downgrade only on positively-confirmed third-party authorship).

The escalation now carries a distinct `ASSETS_MISSING_EXPORT` code (naming the missing `binding`, `exporter`, and `importer`), and `viteBuildClientDeps().bundle()` re-throws it unflattened instead of collapsing it into the generic `ASSETS_BUNDLE_FAILED` — so a programmatic `buildClient` caller, not just the console, sees exactly which binding missed.
