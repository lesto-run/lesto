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
 * with no HTML change. Before Vite starts, `writeScanEntry` lands that same entry on
 * DISK for Vite's dep scanner to seed from (a virtual module is invisible to it) — the
 * one thing here that must happen ahead of `createServer`.
 *
 * NOTE (un-runnable in the build sandbox): the live HMR round-trip — an island edit
 * preserving `useState` — needs a real `lesto dev` + browser, which cannot bind ports
 * here. The Vite TRANSFORM is verifiable in-process (see the integration test), as is
 * the cold-start optimizer pass count (`vite.optimize-deps.integration.test.ts`, which
 * drives `writeScanEntry` + `createServer` in `middlewareMode`). Known risks to validate
 * in e2e: Vite's HMR-WS Origin check across ports and the `@prefresh/vite` preamble.
 */

import { bunBuildClientDeps, resolveInstalledPackage } from "@lesto/assets";
import type { HandleOptions, LestoResponse } from "@lesto/web";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "vite";
import type { InlineConfig, Plugin, PluginOption } from "vite";

import type { CreateBackendRequest, IslandDevBackend, IslandDevDeps } from "./dev-server";
import { SCAN_ENTRY_PATH } from "./entry";
import { ENTRY_PATH } from "./paths";
import { proxyHeaders, viteQuery } from "./proxy";

/**
 * Load the dialect's Fast-Refresh plugin — LAZILY, and only the matched one. The
 * laziness is load-bearing, not cosmetic: `@prefresh/vite` drags in a `rolldown`
 * NATIVE binding whose initialization DEADLOCKS the Bun dev process if it is loaded
 * (a static `import` would load it for EVERY app, react or preact). Importing only
 * `@vitejs/plugin-react` for a react app — the common case — sidesteps it entirely;
 * a preact app pays the cost only when it opts in.
 */
async function loadFastRefreshPlugin(request: CreateBackendRequest): Promise<PluginOption> {
  if (request.pluginSpec.dialect === "react") {
    return (await import("@vitejs/plugin-react")).default();
  }

  return (await import("@prefresh/vite")).default();
}

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
async function inlineConfig(request: CreateBackendRequest): Promise<InlineConfig> {
  const fastRefresh = await loadFastRefreshPlugin(request);

  // The plugins are typed against the Fast-Refresh plugin's own resolved `vite` copy,
  // nominally distinct from this package's `vite` even though it is the same engine at
  // runtime — the cast bridges that duplicate-install type gap (the irreducible bundler
  // edge, typed loosely exactly as the CLI bin types its `Bun` wiring).
  return {
    ...request.config,
    plugins: [islandEntryPlugin(request.entrySource), fastRefresh] as PluginOption[],
  };
}

/**
 * Proxy a Vite-owned request to the internal Vite server and adapt its response.
 *
 * The body is carried as raw BYTES (`arrayBuffer` → `Uint8Array`), never decoded to a
 * string: Vite serves binary modules/assets (an island's imported `.png`/`.woff2`,
 * `?url` assets, `.wasm`, source maps) under the very base it owns, and a UTF-8
 * round-trip would corrupt them. The runtime writes a `Uint8Array` body verbatim — the
 * `as unknown as string` is the transport-widening cast the dispatch contract uses for
 * non-string bodies (mirrors `withLiveReload`'s stream handling). Request headers ride
 * along so Vite's `If-None-Match`/`Accept` 304 fast-path works; `viteQuery` re-attaches
 * the `?v=`/`?t=`/`?import` Vite needs (Lesto split it into `options.query`).
 */
async function proxyToVite(
  origin: string,
  method: string,
  path: string,
  options?: HandleOptions,
): Promise<LestoResponse> {
  const response = await fetch(origin + path + viteQuery(options?.query), {
    method,
    redirect: "manual",
    ...(options?.headers === undefined ? {} : { headers: options.headers }),
  });

  const body = new Uint8Array(await response.arrayBuffer());

  return {
    status: response.status,
    headers: proxyHeaders(response.headers),
    body: body as unknown as string,
  };
}

/**
 * Write the scan-only entry twin Vite's dep scanner reads (`optimizeDeps.entries`).
 *
 * It MUST land before `createServer`: the scanner globs `entries` during the optimizer's
 * boot scan, and `computeEntries` silently drops any entry that does not yet `existsSync`
 * — a missing file degrades to the very "scanner never runs" state this closes, without
 * an error. Rewritten every boot, so a changed island set can never leave a stale graph.
 *
 * BEST-EFFORT, never fatal. The twin only SEEDS the dep scanner to collapse a cold start to
 * ONE optimizer pass; a failed write just leaves the pre-L-90d2de01 behavior (an occasional
 * cold-start re-optimize that the browser recovers from). So a write error — read-only
 * `node_modules`, `.lesto` shadowed by a real file (`ENOTDIR`), a torn concurrent-boot write
 * — is warned (actionably: the path + the perf consequence) and SWALLOWED. It must NOT
 * propagate: an unhandled throw here reaches {@link createViteBackend} → `startBackend` wraps
 * it as `ISLAND_DEV_SERVER_FAILED` and kills `lesto dev` — trading a perf hint for a dead dev
 * server. (Today Vite's default `cacheDir` also lives under `node_modules`, so a read-only
 * tree already fails at `createServer`; this guard is the margin for the `ENOTDIR`/race edges
 * and for any future out-of-`node_modules` `cacheDir`.)
 *
 * Exported (the only thing this coverage-excluded edge exports beyond the deps factory)
 * so `vite.optimize-deps.integration.test.ts` seeds the scanner through the SAME code the
 * dev boot runs — a test that computed the path itself could not catch it drifting here.
 */
export function writeScanEntry(root: string, source: string): void {
  const file = join(root, SCAN_ENTRY_PATH);

  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source, "utf8");
  } catch (cause) {
    console.warn(
      `lesto: could not write the island dep-scanner seed (${file}) — ${String(cause)}. ` +
        `Dev still works; a cold start may re-optimize and reload the page once on first load.`,
    );
  }
}

/** Stand up the real Vite server and wrap it as an {@link IslandDevBackend}. */
async function createViteBackend(request: CreateBackendRequest): Promise<IslandDevBackend> {
  writeScanEntry(request.config.root, request.scanEntrySource);

  const server = await createServer(await inlineConfig(request));

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
    // The SAME node_modules walk `buildClient`'s RUM preflight uses (runtime-agnostic — a pure
    // `existsSync` walk, no `Bun` global), so the dev-boot guard resolves the RUM import exactly
    // as the build does. `root` is the app root the walk starts from.
    resolveClientImport: (specifier) => resolveInstalledPackage(specifier, root, existsSync),
    createBackend: createViteBackend,
  };
}
