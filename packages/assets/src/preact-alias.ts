/**
 * The React → Preact specifier map for the opt-in Preact client dialect (ADR
 * 0007/0008/0011).
 *
 * When an app's `ui.dialect` is `"preact"`, the client bundle resolves every
 * React specifier to Preact's compat layer, shrinking the runtime from ~118 KB
 * to ~10 KB gzip. Most go straight to `preact/compat`; the two `react-dom`
 * entries point at this package's inert shims (`./shims/*`), because `@keel/ui`'s
 * barrel drags React 19's resource-hint exports and `react-dom/server` into the
 * client graph even though the browser never calls them — see the shim files.
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
 * Each aliased specifier → its Preact target. Shim targets are resolved relative
 * to this package; bare specifiers resolve in the consuming app's graph.
 */
export const PREACT_ALIAS: Readonly<Record<string, string>> = {
  react: "preact/compat",
  // The React-19 resource hints (`preload`/`preinit`/…) Preact omits but the
  // `@keel/ui` barrel imports — a no-op shim so the import resolves.
  "react-dom": "@keel/assets/shims/react-dom",
  // `createRoot`/`hydrateRoot` — Preact mirrors them here, the only non-compat entry.
  "react-dom/client": "preact/compat/client",
  // Dragged into the client graph by the barrel but never run on the browser;
  // the real module's top-level bootstrap throws once React is aliased away.
  "react-dom/server": "@keel/assets/shims/react-dom-server",
  // The automatic JSX runtime the app's `jsx: react-jsx` emits.
  "react/jsx-runtime": "preact/jsx-runtime",
  "react/jsx-dev-runtime": "preact/jsx-runtime",
};
