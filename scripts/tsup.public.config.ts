/**
 * The shared tsup config for building the public `@lesto/*` surface (`scripts/lib/build-public.mjs`
 * passes it to every package build via `--config`). Entries/format/dts/target/clean stay on the CLI
 * invocation; this file exists for ONE setting:
 *
 *   removeNodeProtocol: false
 *
 * tsup 8.x defaults `removeNodeProtocol: true`, which STRIPS the `node:` prefix from built-in
 * specifiers (`node:crypto` → `crypto`) in the emitted dist. The framework uses `node:` DELIBERATELY
 * for edge safety: a Cloudflare Worker on older `nodejs_compat` (compat date before 2024-09-23)
 * won't resolve a bare `async_hooks`/`crypto`, and a browser-targeting bundler can silently resolve
 * bare `crypto` to the deprecated npm `crypto` shim instead of the built-in. So we turn the strip
 * OFF and ship `node:` exactly as authored. (L-2c592379.)
 *
 * This is the first-class replacement for a former post-build regex codemod (`restoreNodeProtocol`)
 * that re-added `node:` by scanning dist — that codemod was blind to lexical context and could have
 * rewritten a built-in name appearing inside a string/template literal in a codegen package
 * (`@lesto/cli`, `create-lesto`). The build-tool option cannot misfire that way.
 */
export default { removeNodeProtocol: false };
