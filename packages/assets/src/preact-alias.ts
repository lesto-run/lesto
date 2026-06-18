/**
 * The React → Preact specifier map for the opt-in Preact client dialect (ADR
 * 0007/0008/0011).
 *
 * When an app's `ui.dialect` is `"preact"`, the client bundle resolves every
 * React specifier to Preact's compat layer, shrinking the runtime from ~118 KB
 * to ~10 KB gzip. `react` → `preact/compat`, the client renderer
 * (`createRoot`/`hydrateRoot`) → `preact/compat/client`, and the automatic JSX
 * runtime → `preact/jsx-runtime`.
 *
 * There is deliberately NO `react-dom` or `react-dom/server` entry. Before the
 * `@lesto/ui` barrel split (Wave 2), the isomorphic barrel re-exported the page
 * renderers, dragging `react-dom/server` (and the bare-`react-dom` resource
 * hints) into every client graph — so inert shims had to alias them away. Now the
 * server-render surface lives behind `@lesto/ui/server`, which the client bundle
 * never imports, so neither specifier reaches the browser graph at all and no
 * shim is needed. A stray `react-dom` import in app code is therefore a real
 * unresolved-module build error, not a silently-shimmed no-op — the honest signal.
 *
 * The map is the pure, dialect-agnostic data; the Bun resolver plugin that
 * applies it (`bun.ts`) is the runtime that depends on `Bun.resolveSync`. Kept
 * apart so the alias set is asserted without a bundler.
 *
 * Sound ONLY for deferred (`ssr: false`) islands, which mount fresh on the
 * client — an `ssr: true` island additionally needs the SERVER renderer switched
 * to Preact (the matched pair, ADR 0008), which the dialect config drives.
 */

/**
 * Each aliased specifier → its Preact target. Bare specifiers resolve in the
 * consuming app's graph (its `node_modules`).
 */
export const PREACT_ALIAS: Readonly<Record<string, string>> = {
  react: "preact/compat",
  // `createRoot`/`hydrateRoot` — Preact mirrors them here, the only non-compat entry.
  "react-dom/client": "preact/compat/client",
  // The automatic JSX runtime the app's `jsx: react-jsx` emits.
  "react/jsx-runtime": "preact/jsx-runtime",
  "react/jsx-dev-runtime": "preact/jsx-runtime",
};
