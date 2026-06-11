/**
 * The `react-dom` shim for the Preact client dialect (ADR 0007/0011).
 *
 * `preact/compat` covers React's component API but NOT React 19's resource-hint
 * exports (`preload`, `preinit`, `preinitModule`, `preconnect`, `prefetchDNS`),
 * which `@keel/ui`'s barrel imports from `react-dom` (they instruct
 * `react-dom/server` to emit `<link rel=preload>` markup during a SERVER render).
 * A bare `react-dom` → `preact/compat` alias would fail the bundle with "no
 * matching export" before tree-shaking. So this re-exports compat and adds the
 * five hints as no-ops — present so the import resolves, inert because the
 * browser never calls them (a deferred island mounts fresh; nothing server here).
 * Loaded only under the Preact dialect; the React build imports the real module.
 */

export * from "preact/compat";

/** No-op `react-dom` resource hints — present to satisfy the import, never called on the client. */
export function preload(): void {}
export function preinit(): void {}
export function preinitModule(): void {}
export function preconnect(): void {}
export function prefetchDNS(): void {}
