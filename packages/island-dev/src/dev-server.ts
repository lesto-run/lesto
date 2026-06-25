/**
 * The island dev server — pure orchestration over an injected Vite backend.
 *
 *   const islandDev = await createIslandDevServer(
 *     { root, islandsDir, dialect: "react", vitePort, hmrPort },  // free ports, per-`lesto dev`
 *     viteIslandDevDeps(),
 *   );
 *   // in the CLI dev dispatch:
 *   islandDev.ownsPath("/client.js")  // → true: route to islandDev.handle
 *
 * It lists the app's islands, synthesizes the dev entry, builds the (narrow) Vite
 * config, and asks the injected backend to stand the server up — then exposes the
 * four seams the CLI dev path drives: `ownsPath` (the dispatch branch predicate),
 * `handle` (serve a Vite-owned module), `transformHtml` (inject the Vite client +
 * Fast-Refresh preamble into a dev document), and `close`. The real Vite
 * `createServer` + `listen()` + fetch-proxy lives in the coverage-excluded `vite.ts`
 * edge ({@link IslandDevDeps}); this orchestration is covered with a fake backend.
 */

import type { IslandFile } from "@lesto/assets";
import type { HandleOptions, LestoResponse } from "@lesto/web";

import { viteIslandConfig } from "./config";
import type { ViteIslandConfig } from "./config";
import { dialectPluginSpec } from "./dialect";
import type { DialectPluginSpec } from "./dialect";
import { devEntrySource } from "./entry";
import { IslandDevError } from "./errors";
import { isViteOwnedPath } from "./paths";

/** What the CLI dev path drives — the island dev server's public seam. */
export interface IslandDevServer {
  /** Whether a request path is Vite's (route it to {@link handle}) rather than the app's. */
  ownsPath: (path: string) => boolean;

  /** Serve a Vite-owned request (a module, the entry, the client runtime). */
  handle: (method: string, path: string, options?: HandleOptions) => Promise<LestoResponse>;

  /** Inject the Vite client + the dialect's Fast-Refresh preamble into a dev HTML document. */
  transformHtml: (url: string, html: string) => Promise<string>;

  /** Tear the Vite dev server and its HMR socket down. */
  close: () => Promise<void>;
}

/** The IO surface the coverage-excluded `vite.ts` edge implements; tests fake it. */
export interface IslandDevBackend {
  handle: (method: string, path: string, options?: HandleOptions) => Promise<LestoResponse>;
  transformHtml: (url: string, html: string) => Promise<string>;
  close: () => Promise<void>;
}

/** The request the orchestration hands the backend to construct a Vite server. */
export interface CreateBackendRequest {
  /** The narrow Vite config (base, ports, HMR port, define, alias). */
  readonly config: ViteIslandConfig;

  /** The synthesized dev entry source Vite serves at `/client.js`. */
  readonly entrySource: string;

  /** The matched-pair plugin the backend must instantiate (ADR 0008). */
  readonly pluginSpec: DialectPluginSpec;
}

/** The injected IO seams (real impl: `viteIslandDevDeps()` in `vite.ts`). */
export interface IslandDevDeps {
  /** Discover + classify the app's islands (the same listing `lesto build` uses). */
  listIslands: (islandsDir: string) => Promise<readonly IslandFile[]>;

  /** Stand up the real (loopback, proxied) Vite dev server for the given config + entry. */
  createBackend: (request: CreateBackendRequest) => Promise<IslandDevBackend>;
}

/** Inputs to {@link createIslandDevServer}. */
export interface IslandDevOptions {
  /** The project root. */
  readonly root: string;

  /** The `app/islands/` directory to discover islands under. */
  readonly islandsDir: string;

  /** The client dialect (`ui.dialect`, ADR 0008) — picks the Fast-Refresh plugin. */
  readonly dialect: string;

  /** The internal loopback port Vite's HTTP server listens on (the CLI proxies to it). */
  readonly vitePort: number;

  /** The dedicated port for Vite's HMR WebSocket. */
  readonly hmrPort: number;

  /** The verified PUBLIC_* inject map, or absent (no public config to inline). */
  readonly publicEnvDefine?: Record<string, string>;
}

/**
 * Build an island dev server.
 *
 * Validates the dialect (`ISLAND_DEV_UNKNOWN_DIALECT` on anything but react/preact),
 * lists islands, synthesizes the dev entry, builds the Vite config, and stands the
 * backend up. A backend that fails to start (a bound HMR port, a bad plugin) is
 * wrapped as `ISLAND_DEV_SERVER_FAILED` carrying the cause, so the CLI can paint it
 * rather than crash the dev boot.
 */
export async function createIslandDevServer(
  options: IslandDevOptions,
  deps: IslandDevDeps,
): Promise<IslandDevServer> {
  // Validate the dialect FIRST (before any IO): an unknown dialect can never produce
  // a working Fast-Refresh server, so fail by name before listing islands or starting
  // Vite. The spec also names the plugin the backend will instantiate.
  const pluginSpec = dialectPluginSpec(options.dialect);

  const islands = await deps.listIslands(options.islandsDir);

  const config = viteIslandConfig({
    root: options.root,
    vitePort: options.vitePort,
    hmrPort: options.hmrPort,
    dialect: pluginSpec.dialect,
    ...(options.publicEnvDefine === undefined ? {} : { publicEnvDefine: options.publicEnvDefine }),
  });

  const backend = await startBackend(deps, {
    config,
    entrySource: devEntrySource(islands),
    pluginSpec,
  });

  return {
    ownsPath: isViteOwnedPath,
    handle: backend.handle,
    transformHtml: backend.transformHtml,
    close: backend.close,
  };
}

/** Start the backend, wrapping any startup failure in a coded {@link IslandDevError}. */
async function startBackend(
  deps: IslandDevDeps,
  request: CreateBackendRequest,
): Promise<IslandDevBackend> {
  try {
    return await deps.createBackend(request);
  } catch (cause) {
    throw new IslandDevError(
      "ISLAND_DEV_SERVER_FAILED",
      "the island dev server (Vite) failed to start",
      { cause },
    );
  }
}
