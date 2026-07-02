/**
 * The `react-dom` shim for the OPT-IN `--preact` build of estate's SSR WORKER.
 *
 * Preact's `preact/compat` covers React's component API, but NOT React 19's
 * server resource-hint exports (`preload`, `preinit`, `preinitModule`,
 * `preconnect`, `prefetchDNS`). `@lesto/ui/server`'s barrel pulls `resources.ts`,
 * which imports those names from bare `react-dom`, into the worker graph —
 * `worker.ts` imports `@lesto/ui/server` for `preactServerRenderer` — so a bare
 * `react-dom` -> `preact/compat` alias fails the worker bundle with "no matching
 * export" before any tree-shaking runs. This shim re-exports everything Preact's
 * compat provides and adds the five missing hints as no-ops, so the import
 * resolves.
 *
 * Those hints tell `react-dom/server` to emit `<link rel=preload>` markup during a
 * React render; under Preact's `preact-render-to-string` renderer they have no
 * wiring, and estate calls none of them, so the no-ops are inert, not lossy. Only
 * the worker aliases `react-dom` here (`wrangler.jsonc`), because only the worker
 * imports the `@lesto/ui/server` surface that drags `resources.ts` in. The CLIENT
 * bundle (`build-client.ts --preact`) no longer references bare `react-dom` at all
 * — `resources.ts` moved off the isomorphic `@lesto/ui` barrel the client imports
 * — so `build-client.ts` dropped its `react-dom` alias entry. The default React
 * build (worker and client) imports the real `react-dom` and is untouched.
 */

export * from "preact/compat";

/** No-op `react-dom` resource hints — present to satisfy the import, never called on the client. */
export function preload(): void {}
export function preinit(): void {}
export function preinitModule(): void {}
export function preconnect(): void {}
export function prefetchDNS(): void {}
