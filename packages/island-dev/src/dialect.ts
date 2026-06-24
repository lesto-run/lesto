/**
 * The ADR-0008 matched pair, dev edition: the Fast-Refresh plugin is selected from
 * the SAME `ui.dialect` key that picks the client alias and the server renderer, so
 * dev HMR speaks the dialect the app hydrates against. `react` and `preact` need
 * different, matched plugins — `@vitejs/plugin-react` vs `@prefresh/vite` — and
 * pairing them wrong (e.g. the React plugin over a Preact bundle) silently breaks
 * Fast Refresh. This pure selection refuses an unknown dialect by name; the actual
 * plugin instantiation lives in the coverage-excluded `vite.ts` edge.
 */

import { IslandDevError } from "./errors";

/** The island client dialects Fast Refresh supports (ADR 0008's matched pair). */
export type IslandDialect = "react" | "preact";

/** Which Fast-Refresh plugin a dialect maps to, plus the dialect it resolved. */
export interface DialectPluginSpec {
  readonly dialect: IslandDialect;
  readonly module: "@vitejs/plugin-react" | "@prefresh/vite";
}

/**
 * Resolve a dialect string to its Fast-Refresh plugin spec.
 *
 * `react` → `@vitejs/plugin-react`; `preact` → `@prefresh/vite`. Anything else is
 * an {@link IslandDevError} (`ISLAND_DEV_UNKNOWN_DIALECT`) rather than a dev server
 * with no module-level HMR — a misconfigured `ui.dialect` fails by name.
 */
export function dialectPluginSpec(dialect: string): DialectPluginSpec {
  if (dialect === "react") return { dialect, module: "@vitejs/plugin-react" };

  if (dialect === "preact") return { dialect, module: "@prefresh/vite" };

  throw new IslandDevError(
    "ISLAND_DEV_UNKNOWN_DIALECT",
    `island Fast Refresh supports the "react" and "preact" dialects, not "${dialect}"`,
    { dialect },
  );
}
