---
"@lesto/assets": patch
---

Stop the prod Vite build from swallowing every `MISSING_EXPORT` warning.

The build downgraded *all* Rollup `MISSING_EXPORT` warnings to a silent `console.warn` to contain one framework-internal case (`@lesto/ui`'s `define-island` reading `React.use`, which `preact/compat` doesn't export). That also swallowed a user's genuine namespace-member typo (`ns.missing`), which then shipped as `undefined`. The downgrade is now narrowed to exactly the contained case — `warning.binding === "use"` from a `preact/compat` exporter (via a new pure `shouldSwallowMissingExport` predicate) — so every other `MISSING_EXPORT` is surfaced through Vite's normal warning path again instead of being hidden.

(Note: in the current Vite, a namespace-member `MISSING_EXPORT` is surfaced as a warning, not a hard build error; making a first-party typo *fail* the build is tracked as follow-up work.)
