---
"@lesto/assets": minor
"@lesto/ui": minor
"@lesto/web": patch
---

**BREAKING (`@lesto/ui`, 0.x minor):** `createSourceResolver(load, use)` now takes React's `use` as a required second argument, and `SourceResolver` carries a required `use<T>(thenable: PromiseLike<T>): T` member. Both are exported from `@lesto/ui`. The framework's only caller (`@lesto/web`) is updated; a custom caller of `createSourceResolver` must pass `use` from `react`.

**Behavior change — `lesto build` now FAILS on a genuine `MISSING_EXPORT` (code `ASSETS_MISSING_EXPORT`) instead of shipping `undefined`.**

Rollup classifies a namespace-member access of a name a module does not export (`ns.typo`, or an unreferenced `import { typo }`) as a NON-FATAL `MISSING_EXPORT` warning and compiles the access to a literal `undefined` — and Vite's default handler only *warns* it (only `UNRESOLVED_IMPORT` throws). So a user's genuine island-code typo previously shipped to production silently as `undefined`. The prod Vite build (`@lesto/assets`) now escalates a `MISSING_EXPORT` **authored in your own (first-party) code** to a fatal, coded `AssetsError` that names the missing binding, its module, and the importer (a miss inside a `node_modules` dependency stays a plain warning — see the `assets-missing-export-scope` note). This deliberately diverges from `Bun.build`, which silently ships the same access as `undefined` — that silence is the bug, not a parity target.

**If your build now fails with `ASSETS_MISSING_EXPORT`:** it names the missing `binding` and its `exporter` module. Almost always it is a real typo in an import/namespace access — fix the name. If instead you *intend* an optional-feature probe against a name the target may not export (`ns.maybe ?? fallback`), use a computed-key access (`ns["maybe"]`) — Rollup's static-member analysis does not flag a computed access, so it stays the runtime `undefined` you want.

To make the escalation safe, the one framework-internal case that produced a `MISSING_EXPORT` is gone. `@lesto/ui`'s `define-island` used to read `React.use` off the React namespace so no `import { use }` would break the preact-dialect client bundle (`preact/compat` exports no `use`). The per-request source resolver now *carries* React's `use` (`@lesto/web` — server-only — threads it into `createSourceResolver`, and `defineIsland` calls `resolver.use`), so no `react` specifier rides the client island graph and nothing reads `use` off the aliased namespace. `use` is still called during the server render (through the resolver alias, which React's dispatcher permits — it is the one hook legal in loops and conditionals), so suspension, memoized sharing, and the pre-fulfilled sync-thenable path all behave identically; the client never renders that wrapper.
