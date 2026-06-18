/**
 * The `react-dom` shim for the OPT-IN `--preact` client bundle.
 *
 * Preact's `preact/compat` covers React's component API, but NOT React 19's
 * server resource-hint exports (`preload`, `preinit`, `preinitModule`,
 * `preconnect`, `prefetchDNS`). `@lesto/ui`'s barrel pulls `resources.ts`, which
 * imports those names from `react-dom`, into the client graph — so a bare
 * `react-dom` -> `preact/compat` alias fails the bundle with "no matching export"
 * before any tree-shaking runs.
 *
 * Those hints are a SERVER concern: they tell `react-dom/server` to emit
 * `<link rel=preload>` markup during render. They are never called on the client,
 * least of all by a deferred island that mounts fresh with `createRoot`. So this
 * shim re-exports everything Preact's compat provides and adds the five missing
 * hints as no-ops — present so the import resolves, inert because the client
 * never invokes them. This is loaded only when `--preact` is set; the default
 * React build imports the real `react-dom` and is untouched.
 */

export * from "preact/compat";

/** No-op `react-dom` resource hints — present to satisfy the import, never called on the client. */
export function preload(): void {}
export function preinit(): void {}
export function preinitModule(): void {}
export function preconnect(): void {}
export function prefetchDNS(): void {}
