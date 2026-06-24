/**
 * The real Vite wiring behind {@link IslandDevDeps}'s seams — the `bin`-equivalent of
 * this package (excluded from the coverage gate exactly as `@lesto/assets`'s `bun.ts`
 * and `@lesto/styles`'s `tailwind.ts`): it cannot run under vitest, while the
 * orchestration it feeds (`dev-server.ts`) is covered with fakes.
 *
 * It stands up a real Vite dev server on an internal loopback port and exposes three
 * things to the CLI:
 *   - `handle` — PROXIES a Vite-owned request to that server with `fetch`, so the
 *     browser only ever talks to the app's own origin (no cross-origin, no CORS, no
 *     HTML rewrite). The HTTP module graph is proxied; Vite's HMR WebSocket runs on a
 *     dedicated port the browser connects to directly.
 *   - `transformHtml` — `vite.transformIndexHtml`, which injects the Vite client and
 *     the dialect plugin's React/Preact Fast-Refresh PREAMBLE into the dev document.
 *   - `close` — tears the Vite server (and its HMR socket) down.
 *
 * The synthesized entry is served at `/client.js` via a virtual-module plugin, so the
 * app's existing `<script src="/client.js">` is the Fast-Refresh-transformed entry
 * with no HTML change.
 *
 * NOTE (un-runnable in the build sandbox): the live HMR round-trip — an island edit
 * preserving `useState` — needs a real `lesto dev` + browser, which cannot bind ports
 * here. The Vite TRANSFORM is verifiable in-process (see the integration test). Known
 * risks to validate in e2e: Vite's HMR-WS Origin check across ports, `optimizeDeps`
 * tuning for the workspace `@lesto/*` packages, and the `@prefresh/vite` preamble.
 */

import { bunBuildClientDeps } from "@lesto/assets";
import type { HandleOptions, LestoResponse } from "@lesto/web";
import prefresh from "@prefresh/vite";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import type { InlineConfig, Plugin, PluginOption } from "vite";

import type { CreateBackendRequest, IslandDevBackend, IslandDevDeps } from "./dev-server";
import { ENTRY_PATH } from "./paths";

/** The virtual module id the synthesized entry is loaded as (a `.tsx` id so JSX transforms apply). */
const ENTRY_MODULE_ID = "\0lesto-island-entry.tsx";

/** Serve the synthesized dev entry at `/client.js` as a virtual module. */
function islandEntryPlugin(entrySource: string): Plugin {
  return {
    name: "lesto:island-entry",
    // `pre` so this claims `/client.js` before Vite's fs resolver tries (and fails) to
    // read it as a real file under the project root.
    enforce: "pre",
    resolveId(id) {
      return id === ENTRY_PATH ? ENTRY_MODULE_ID : undefined;
    },
    load(id) {
      return id === ENTRY_MODULE_ID ? entrySource : undefined;
    },
  };
}

/** The InlineConfig for the island dev server: the narrow config + the Fast-Refresh + entry plugins. */
function inlineConfig(request: CreateBackendRequest): InlineConfig {
  const fastRefresh = request.pluginSpec.dialect === "react" ? react() : prefresh();

  // `@vitejs/plugin-react` / `@prefresh/vite` are typed against their own resolved
  // `vite` copy, so their `Plugin` type is nominally distinct from this package's
  // `vite` even though they are the same engine at runtime. The cast bridges that
  // duplicate-install type gap — this is the irreducible bundler edge, typed loosely
  // exactly as the CLI bin types its `Bun` wiring.
  return {
    ...request.config,
    plugins: [islandEntryPlugin(request.entrySource), fastRefresh] as PluginOption[],
  };
}

/**
 * Rebuild the `?…` Vite needs from the parsed query the dev server hands us. Lesto's
 * `handle` receives the PATHNAME only (`request.path = url.pathname`), with the query
 * split off into `options.query` — but Vite versions module URLs (`?v=<hash>`,
 * `?t=<ts>`, `?import`, `?direct`), so the proxy MUST re-attach them or HMR and dep
 * pre-bundling break. Key presence is preserved (a flag like `import` becomes
 * `import=`, which Vite reads identically).
 */
function viteQuery(query: HandleOptions["query"]): string {
  if (query === undefined) return "";

  const search = new URLSearchParams(query).toString();

  return search === "" ? "" : `?${search}`;
}

/** Proxy a Vite-owned request to the internal Vite server and adapt its response. */
async function proxyToVite(
  origin: string,
  method: string,
  path: string,
  options?: HandleOptions,
): Promise<LestoResponse> {
  const response = await fetch(origin + path + viteQuery(options?.query), {
    method,
    redirect: "manual",
  });

  const body = await response.text();

  return {
    status: response.status,
    // Vite serves JS modules; default to the JS type so a header-less module still
    // executes (the browser refuses `text/html`-typed module scripts).
    headers: { "content-type": response.headers.get("content-type") ?? "application/javascript" },
    body,
  };
}

/** Stand up the real Vite server and wrap it as an {@link IslandDevBackend}. */
async function createViteBackend(request: CreateBackendRequest): Promise<IslandDevBackend> {
  const server = await createServer(inlineConfig(request));

  // `createServer` builds the server but does not bind; listen so the CLI proxy can
  // reach it (and so Vite's HMR socket comes up).
  await server.listen();

  const origin = `http://127.0.0.1:${request.config.server.port}`;

  return {
    handle: (method, path, options) => proxyToVite(origin, method, path, options),
    transformHtml: (url, html) => server.transformIndexHtml(url, html),
    close: () => server.close(),
  };
}

/**
 * The default {@link IslandDevDeps}, wired to real Vite + the `@lesto/assets` island
 * lister (the SAME discovery `lesto build` uses, so dev and prod see one island set).
 */
export function viteIslandDevDeps(root: string): IslandDevDeps {
  return {
    listIslands: bunBuildClientDeps(root).listIslands,
    createBackend: createViteBackend,
  };
}
