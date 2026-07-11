---
"@lesto/assets": minor
"@lesto/ui": minor
"@lesto/web": patch
---

`lesto build` now FAILS on a genuine `MISSING_EXPORT` instead of shipping `undefined`.

Rollup classifies a namespace-member access of a name a module does not export (`ns.typo`, or an unreferenced `import { typo }`) as a NON-FATAL `MISSING_EXPORT` warning and compiles the access to a literal `undefined` — and Vite's default handler only *warns* it (only `UNRESOLVED_IMPORT` throws). So a user's genuine island-code typo previously shipped to production silently as `undefined`. The prod Vite build (`@lesto/assets`) now escalates **every** `MISSING_EXPORT` to a fatal, coded `AssetsError` that names the missing binding and its module, failing the build where it previously only warned. This deliberately diverges from `Bun.build`, which silently ships the same access as `undefined` — that silence is the bug, not a parity target.

This is a behavior change: a build that emitted a `MISSING_EXPORT` warning now fails.

To make that escalation safe, the one framework-internal case that produced a `MISSING_EXPORT` is gone. `@lesto/ui`'s `define-island` used to read `React.use` off the React namespace so no `import { use }` would break the preact-dialect client bundle (`preact/compat` exports no `use`). The per-request source resolver now *carries* React's `use` (`@lesto/web` — server-only — threads it into `createSourceResolver`, and `defineIsland` calls `resolver.use`), so no `react` specifier rides the client island graph and nothing reads `use` off the aliased namespace. `use` is still called during the server render (through the resolver alias, which React's dispatcher permits — it is the one hook legal in loops and conditionals), so suspension, memoized sharing, and the pre-fulfilled sync-thenable path all behave identically; the client never renders that wrapper.

`SourceResolver` now carries a `use<T>(thenable: PromiseLike<T>): T` member and `createSourceResolver(load, use)` takes `use` as a second argument.
