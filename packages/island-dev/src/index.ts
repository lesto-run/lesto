/**
 * @lesto/island-dev — the dev-only island bundler (DX-parity R2, ADR 0011).
 *
 *   const islandDev = await createIslandDevServer(
 *     { root, islandsDir, dialect: "react", vitePort: 24677, hmrPort: 24678 },
 *     viteIslandDevDeps(root),
 *   );
 *   // in `lesto dev`'s dispatch:
 *   if (islandDev.ownsPath(path)) return islandDev.handle(method, path, options);
 *
 * A Vite middleware dev server with React/Preact Fast Refresh, so `lesto dev`
 * preserves island state on edit instead of reloading the page. `createIslandDevServer`
 * is pure orchestration over an injected Vite backend ({@link IslandDevDeps}); the real
 * `vite.createServer` + fetch-proxy edge is the separate coverage-excluded
 * `viteIslandDevDeps`. The app's HTML and request path are untouched — Vite serves the
 * entry at the app's existing `/client.js` and its modules under Vite-internal prefixes.
 */

export { createIslandDevServer } from "./dev-server";
export type {
  CreateBackendRequest,
  IslandDevBackend,
  IslandDevDeps,
  IslandDevOptions,
  IslandDevServer,
} from "./dev-server";

export { viteIslandConfig } from "./config";
export type { ViteIslandAlias, ViteIslandConfig, ViteIslandConfigOptions } from "./config";

export { dialectPluginSpec } from "./dialect";
export type { DialectPluginSpec, IslandDialect } from "./dialect";

export { devEntrySource } from "./entry";

export { ENTRY_PATH, isViteOwnedPath, VITE_PREFIXES } from "./paths";

export { viteIslandDevDeps } from "./vite";

export { IslandDevError, LestoError } from "./errors";
export type { IslandDevErrorCode } from "./errors";
