---
"@lesto/ui": patch
"@lesto/web": patch
"@lesto/assets": patch
---

0.1.7 hotfix — resolve the three src→dist migration regressions shipped in 0.1.6

- **Lazy Preact server renderer (`@lesto/ui`, `@lesto/web`).** `preactServerRenderer` is no longer eagerly re-exported from `@lesto/ui/server`; it moves to a dedicated `@lesto/ui/server-preact` subpath, and `@lesto/web` loads it lazily only when the Preact dialect is selected (`applyUiDialect` is now async). A plain-Node React app that installs `@lesto/web` (or `@lesto/cloudflare`) no longer crashes on import for the optional `preact-render-to-string` peer it never asked for.
- **jiti island loader (`@lesto/assets`).** `readIsland` loads a user island module through a jiti instance instead of a bare `import()`, so `lesto build`/`lesto dev` no longer crash under plain Node on a `.tsx` island (`ERR_UNKNOWN_FILE_EXTENSION`).
- **`node:` prefix preserved in the published build.** The publish build now restores the `node:` prefix that tsup strips from built-in specifiers, so edge/bundler consumers resolve `node:crypto`/`node:async_hooks` correctly.

The import-proof gate now imports the React flagship (`@lesto/web`/`ui`/`router`/`forms`/`cloudflare`) in a clean external consumer WITHOUT the Preact peer, and `pack-and-boot` now runs `lesto build` under Node — the standing guards for the above.
