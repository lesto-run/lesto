#!/usr/bin/env bun
/**
 * The `lesto` executable — pure wiring, no logic.
 *
 * It builds the real dependencies (load the project's `lesto.app.ts`, the real
 * runtime `serve`, `console.log`) and hands them to the covered `run` core.
 * `serve`/`dev` resolve once listening; the process stays alive on its own
 * open socket, so we only exit non-`serve` commands.
 */

import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo, Server as NetServer } from "node:net";
import { dirname, join } from "node:path";

import { nodeStaticReader, serve } from "@lesto/runtime";
import type { LestoAppConfig } from "@lesto/kernel";
import { compileFileRoutes, scanRoutes } from "@lesto/router";
import { applyFileRoutes, generateRouteManifest, loadFileRoutes } from "@lesto/web";
import type { UiDialect } from "@lesto/web";
import type { TraceSeams } from "@lesto/observability";

import type { EngineConfig, RuntimeEntry } from "@lesto/content-core";

import { defineSites, nodeSink } from "@lesto/sites";
import type { Site } from "@lesto/sites";

import { nodeReleaseStore, nodeUploader, remoteReleaseStore } from "@lesto/deploy";
import type { ReleaseStore } from "@lesto/deploy";

import { buildClient, bunBuildClientDeps } from "@lesto/assets";
import type { PublicEnvDefine } from "@lesto/assets";
import { clientDefineMap } from "@lesto/env";
import type { ClientSchema } from "@lesto/env";

import { createApp } from "@lesto/kernel";

import { declaresIslandDevPeer, run } from "./run";
import type {
  BuildHook,
  CliDeps,
  CloudflareDeployer,
  DevError,
  IslandDevServer,
  ReleaseTarget,
} from "./run";
import { devReloadClientScript } from "./dev-overlay";
import { CliError } from "./errors";
import { WRANGLER_DEPLOY_ARGS, WRANGLER_ROLLBACK_MESSAGE, wranglerRollbackArgs } from "./wrangler";
import { runMcp, startMcpServer } from "./mcp";
import { runOpenApi } from "./openapi";
import { runGenerate } from "./generate";
import type { GenerateIO } from "./generate";
import { createCollectionsReader, runGenerateAgents } from "./agents/run";
import type { RouteDescriptor } from "./agents/types";

/**
 * Run a `wrangler` subcommand, streaming its output and resolving with the
 * captured stdout (so the deploy URL can be parsed from it). A non-zero exit — or
 * a missing binary — rejects, which `runDeploy` surfaces.
 *
 * This is the irreducible deploy edge: it spawns Cloudflare's official tool, so it
 * lives in this coverage-excluded wiring while the gated orchestration around it
 * (deploy → health → rollback) is fully tested in `run.ts`. The exact flags are
 * validated against a real account at deploy time, not in CI.
 */
function runWrangler(subcommand: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("wrangler", [...subcommand], { stdio: ["inherit", "pipe", "inherit"] });

    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();

      process.stdout.write(chunk);
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) resolveOutput(stdout);
      else reject(new Error(`wrangler ${subcommand[0] ?? ""} exited with code ${code ?? "null"}`));
    });
  });
}

/** The real Cloudflare driver: the official `wrangler` CLI (see {@link CloudflareDeployer}). */
const wranglerDeployer: CloudflareDeployer = {
  deploy: async () => {
    const output = await runWrangler(WRANGLER_DEPLOY_ARGS);

    // wrangler prints the live URL on a successful deploy; recover it so the
    // result can be health-gated. Absent a match, the gate is skipped (out loud).
    const match = output.match(/https:\/\/\S+\.workers\.dev\S*/);

    return { url: match?.[0] };
  },

  rollback: async () => {
    await runWrangler(wranglerRollbackArgs(WRANGLER_ROLLBACK_MESSAGE));
  },
};

/** Probe a deployed URL, resolving `true` iff it answers OK within the timeout. */
async function httpHealthCheck(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

    return response.ok;
  } catch {
    // A refused connection, DNS miss, non-2xx, or timeout all mean "not healthy".
    return false;
  }
}

/** A set, non-empty env var, else `undefined` (treating empty as unset). */
function readEnv(name: string): string | undefined {
  const value = process.env[name];

  return value !== undefined && value !== "" ? value : undefined;
}

/** Like {@link readEnv} but required: a clear, secret-free message names the var. */
function requireEnv(name: string): string {
  const value = readEnv(name);

  if (value === undefined) {
    throw new Error(`Set ${name} to deploy to a remote release store.`);
  }

  return value;
}

/**
 * Build the {@link ReleaseStore} for a resolved {@link ReleaseTarget}: the on-disk
 * `nodeReleaseStore` for a local target, or the S3/R2 `remoteReleaseStore` for a
 * remote one — its SigV4 credentials read from the environment. This is the
 * irreducible credential edge, so it lives in the coverage-excluded wiring; the
 * CLI core only ever sees the seam.
 *
 * Credentials resolve as a FAMILY, not field by field: the `LESTO_DEPLOY_` family
 * is preferred (its access key is the marker), else the conventional `AWS_` names
 * CI already injects. Picking a prefix once — rather than falling back per field —
 * means a `LESTO_DEPLOY_` access key can never be paired with an `AWS_` secret into
 * a mismatched keypair when only half of one family is set.
 */
function releaseStore(target: ReleaseTarget): ReleaseStore {
  if (target.kind === "local") return nodeReleaseStore(target.distDir);

  const prefix = readEnv("LESTO_DEPLOY_ACCESS_KEY_ID") !== undefined ? "LESTO_DEPLOY_" : "AWS_";
  const sessionToken = readEnv(`${prefix}SESSION_TOKEN`);

  return remoteReleaseStore({
    endpoint: target.endpoint,
    bucket: target.bucket,
    region: target.region,
    accessKeyId: requireEnv(`${prefix}ACCESS_KEY_ID`),
    secretAccessKey: requireEnv(`${prefix}SECRET_ACCESS_KEY`),
    // Spread the optionals only when set — `exactOptionalPropertyTypes` forbids
    // assigning `undefined` to an optional property.
    ...(target.pointerKey !== undefined ? { pointerKey: target.pointerKey } : {}),
    ...(sessionToken !== undefined ? { sessionToken } : {}),
  });
}

/** Where `lesto dev` looks for built client assets (e.g. a bundled `/client.js`). */
const DEV_ASSET_DIR = "out";

/** The project's island-convention directory (ADR 0011) — its presence enables the client build. */
const ISLANDS_DIR = "app/islands";

/** The app source root Tailwind scans for utility classes (ADR 0037) — routes, components, islands all live under it. */
const APP_SRC_DIR = "app";

/** Debounce window for the dev island watcher: coalesce a burst of saves into one rebuild. */
const WATCH_DEBOUNCE_MS = 100;

const argv = process.argv.slice(2);

const projectRoot = process.cwd();

const islandsDir = join(projectRoot, ISLANDS_DIR);

// The app source root Tailwind scans + the dev CSS watcher watches (ADR 0037) — the
// whole `app/` tree, since utility classes live in routes, components, and islands.
const appSrcDir = join(projectRoot, APP_SRC_DIR);

// A project's `lesto.app.ts` default-exports EITHER a built `LestoAppConfig` or a
// CONFIG FACTORY `(seams?) => LestoAppConfig | Promise<...>`. The factory shape is
// what lets a served deploy emit db child-spans: when `serve`/`dev` have an OTLP
// tracer on, they pass `traces.seams` here, and a factory wires the `db.onQuery`
// hook into its own `createDb(handle, { onQuery: seams.onQuery })` so a query run
// during a request parents on the request span. A plain-config export ignores the
// arg entirely — unchanged, traced or not.
type AppDefault =
  | LestoAppConfig
  | ((seams?: TraceSeams) => LestoAppConfig | Promise<LestoAppConfig>);

// The file-route convention dir. If a project has one, every `page`/`layout`
// under it is auto-registered — "drop a file → it routes," no manual map.
const ROUTES_DIR = "app/routes";
const routesDir = join(projectRoot, ROUTES_DIR);

// Whether a directory exists (the convention marker for islands/routes).
const dirExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
};

// Scan `app/routes/` with the real `fs.readdir`, yielding the flat DiscoveredFile
// list the pure compiler/codegen take. The one impure seam shared by the route
// applier (below) and the edge-manifest codegen (`regenerateRoutes`).
const scanRoutesDir = () =>
  scanRoutes(
    async (path) =>
      (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      })),
    routesDir,
  );

// Auto-wire file-based routes onto the loaded app: scan `app/routes/`, `import()`
// each page/layout, and register them via `@lesto/web`'s applier. The scan and
// the per-file import are the impure seams the covered core (`scanRoutes`,
// `loadFileRoutes`, `applyFileRoutes`) takes as inputs; this composes them with
// the real `fs.readdir` + `import()`. Node-only by design — it runs under
// `dev`/`serve`/`build`/`routes`; the static-import map a dynamic-edge Worker
// needs is the SEPARATE edge concern `regenerateRoutes` owns (`routes.gen.ts`).
//
// `bust` cache-busts the per-file `import()` (a `?t=<now>` suffix) so a dev
// re-load picks up a NEW or EDITED route file rather than ESM's cached module —
// the Node re-scan half of Workstream 3. A normal boot omits it (one clean import).
const applyDiscoveredRoutes = async (app: LestoAppConfig["app"], bust?: string): Promise<void> => {
  if (!(await dirExists(routesDir))) return;

  const files = await scanRoutesDir();

  const modules = await loadFileRoutes(files, (kind, segments) => {
    const specifier = join(routesDir, ...segments, kind);

    return import(bust === undefined ? specifier : `${specifier}?t=${bust}`);
  });

  applyFileRoutes(app, files, modules);

  // Make the auto-activation visible: file routes register implicitly from the
  // dir's presence, so a one-line note (on stderr, never polluting `routes`'
  // stdout) tells the operator the convention kicked in and how much it found.
  const pages = files.filter((file) => file.kind === "page").length;
  if (pages > 0) {
    console.error(`lesto: registered ${pages} file route(s) from ${ROUTES_DIR}/`);
  }
};

// Load the project's app config + auto-wire its file routes. `bust` (a dev re-load)
// cache-busts BOTH `lesto.app.ts` and the route imports, so an edit is re-imported
// rather than served from ESM's module cache.
const loadAppConfig = async (seams?: TraceSeams, bust?: string): Promise<LestoAppConfig> => {
  const appPath = join(process.cwd(), "lesto.app.ts");
  const module = (await import(bust === undefined ? appPath : `${appPath}?t=${bust}`)) as {
    default: AppDefault;
  };

  const exported = module.default;

  const config = typeof exported === "function" ? await exported(seams) : exported;

  await applyDiscoveredRoutes(config.app, bust);

  return config;
};

const loadApp = (seams?: TraceSeams): Promise<LestoAppConfig> => loadAppConfig(seams);

// `dev`'s on-change re-load: a fresh config with cache-busted route imports, so a
// NEW route appears (and an edited one re-renders) without a server restart.
const reloadApp = (): Promise<LestoAppConfig> => loadAppConfig(undefined, String(Date.now()));

// The edge route manifest path (`src/routes.gen.ts`) and its import base — the same
// `src/routes.gen.ts` + `../app/routes` the per-app `regenerate-routes.ts` used, now
// a first-class `routes:gen` / dev-watch concern.
const ROUTES_MANIFEST = "src/routes.gen.ts";
const ROUTES_IMPORT_BASE = "../app/routes";

// Regenerate the EDGE manifest: scan `app/routes/`, render with the covered
// `generateRouteManifest`, write `src/routes.gen.ts`. Returns the path + file count,
// or `undefined` when the project has no `app/routes/` (nothing to generate). This
// is the edge static-import map — kept separate from the Node re-scan above.
const regenerateRoutes = async (): Promise<{ path: string; count: number } | undefined> => {
  if (!(await dirExists(routesDir))) return undefined;

  const files = await scanRoutesDir();
  const source = generateRouteManifest(files, { importBase: ROUTES_IMPORT_BASE });
  const target = join(projectRoot, ROUTES_MANIFEST);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, "utf8");

  return { path: ROUTES_MANIFEST, count: files.length };
};

// The route descriptors under `app/routes/`, for the agent artifacts' route map
// (`generate agents`): the SAME real `fs` scan the route applier uses, compiled to
// `{ kind, pattern }` by `@lesto/router`'s `compileFileRoutes`. No per-file
// `import()` — the artifacts list only each route's kind and URL, never its module —
// so the scan stays fast and side-effect-free. Absent `app/routes/` → no routes.
const readAgentRoutes = async (): Promise<readonly RouteDescriptor[]> => {
  if (!(await dirExists(routesDir))) return [];

  return compileFileRoutes(await scanRoutesDir()).map((route) => ({
    kind: route.kind,
    pattern: route.pattern,
  }));
};

// Watch `app/routes/` and fire `onChange` at most once per debounce window, like
// `watchIslands` — so a burst of saves coalesces into one re-load. Absent dir → a
// no-op stop handle (dev still runs; there is just nothing to watch).
const watchRoutes = (onChange: () => void): (() => void) => {
  let watcher: ReturnType<typeof watch> | undefined;

  try {
    watcher = watch(routesDir, { recursive: true });
  } catch {
    // No `app/routes/` (or it cannot be watched) — nothing to watch; the dev loop
    // still serves, it just has no route hot-reload. Return a no-op stop handle.
    return () => undefined;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  watcher.on("change", () => {
    clearTimeout(timer);

    timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
  });

  return () => {
    clearTimeout(timer);
    watcher?.close();
  };
};

// True iff the project follows the `app/islands/` convention (ADR 0011); the
// CLI core only builds client assets when this answers true.
const hasIslandsDir = async (): Promise<boolean> => {
  try {
    await access(islandsDir);

    return true;
  } catch {
    return false;
  }
};

// The island module file extensions an `app/islands/` directory may hold — the same
// set `@lesto/assets` recognizes (`bun.ts` `ISLAND_EXTENSIONS`).
const ISLAND_MODULE_EXT = /\.(?:tsx|ts|jsx|js)$/;

// The island module names under `app/islands/`, for the agent artifacts' island
// inventory (`generate agents`). A GLOB, not an `import()`: the basenames (the
// extension and any co-located `.test`/`.spec` or `.d.ts` dropped, hidden files
// skipped) are the agent-legible module names, derivable without loading the
// components — so the doc scan has no side effects and no React/Preact cost. Absent
// `app/islands/` → no islands.
const readAgentIslands = async (): Promise<readonly string[]> => {
  if (!(await hasIslandsDir())) return [];

  const entries = await readdir(islandsDir);

  return entries
    .filter(
      (name) =>
        !name.startsWith(".") &&
        !name.endsWith(".d.ts") &&
        !/\.(?:test|spec)\.[jt]sx?$/.test(name) &&
        ISLAND_MODULE_EXT.test(name),
    )
    .map((name) => name.replace(ISLAND_MODULE_EXT, ""));
};

// Build the island client bundle with @lesto/assets. The CLI core's "dev" mode
// maps to an unminified build; "production" to the minified one. The `dialect`
// is the matched pair's client half (ADR 0008): the CLI core reads the project's
// single `ui.dialect` key and passes it here, while `createApp` wires the server
// renderer from the same value — so the client alias and the server render never
// diverge.
const buildClientAssets = async (options: {
  outDir: string;
  mode: "dev" | "production";
  dialect: UiDialect;
  publicEnvDefine?: PublicEnvDefine;
}): Promise<void> => {
  await buildClient(
    {
      islandsDir,
      outDir: join(projectRoot, options.outDir),
      mode: options.mode === "dev" ? "development" : "production",
      dialect: options.dialect,
      // The verified PUBLIC_* inject map the CLI core resolved (absent → the bundler
      // injects nothing) — baked into island code so `defineClientEnv` reads its
      // public bag in the browser instead of falling back to `{}`.
      ...(options.publicEnvDefine !== undefined
        ? { publicEnvDefine: options.publicEnvDefine }
        : {}),
    },
    bunBuildClientDeps(projectRoot),
  );
};

// The convention module a project declares its PUBLIC_* (client) env schema in:
// `env.client.ts` at the project root — a CLIENT-SAFE module that imports only
// `@lesto/env/client` (never a server secret) and exports a `clientEnv` schema. It
// is kept separate from `env.ts` (which validates the server half against
// `process.env` on import) precisely so resolving the client schema here never runs
// server validation. The scaffold's `env.ts` and its island both import `clientEnv`
// from it, so the inlined bag and what the island reads share ONE source of truth.
const ENV_CLIENT_PATH = join(projectRoot, "env.client.ts");

// Compute the island bundle's PUBLIC_* inject map. If the project declares
// `env.client.ts`, import its `clientEnv` schema and turn it into the verified
// `define`/replace map: `clientDefineMap` validates the PUBLIC_* values against the
// build-time `process.env`, so a missing/malformed required PUBLIC_* var throws here
// (surfaced by the CLI core as a coded build failure, not silently at hydration).
// Absent module — or one with no `clientEnv` export — yields `undefined`, and the
// bundler injects nothing (an app with no public config is unchanged).
const resolvePublicEnvDefine = async (): Promise<PublicEnvDefine | undefined> => {
  if (!(await dirExists(ENV_CLIENT_PATH))) return undefined;

  const module = (await import(ENV_CLIENT_PATH)) as { clientEnv?: ClientSchema };

  if (module.clientEnv === undefined) return undefined;

  return clientDefineMap(module.clientEnv);
};

// The island Fast Refresh ports (DX-parity R2): the loopback HTTP port the CLI proxies
// island modules to, and the dedicated WebSocket port the browser connects to for
// Fast-Refresh updates.
interface IslandDevPorts {
  readonly vitePort: number;
  readonly hmrPort: number;
}

// Pick two DISTINCT free loopback TCP ports for island Fast Refresh. Both ephemeral
// (`:0`) listeners are held open SIMULTANEOUSLY so the OS hands back distinct ports, then
// released. Chosen per `lesto dev` (NOT fixed like `LIVE_RELOAD_PORT`) so a second
// concurrent `lesto dev` claims its own pair instead of colliding on a shared constant —
// the old fixed 24677/24678 made the second app's Vite bind fail (`strictPort`), silently
// degrading it to full reload. A tiny TOCTOU window between release and Vite's bind
// remains; `strictPort` + the `resolveIslandDev` degrade cover it (a lost race → full
// reload, never a crash).
const findIslandDevPorts = (): Promise<IslandDevPorts> =>
  new Promise((resolve, reject) => {
    const servers: NetServer[] = [];
    const ports: number[] = [];

    const closeAll = (done: () => void): void => {
      let pending = servers.length;

      for (const server of servers) {
        server.close(() => {
          pending -= 1;

          if (pending === 0) done();
        });
      }
    };

    const fail = (cause: unknown): void => {
      closeAll(() =>
        reject(cause instanceof Error ? cause : new Error("could not find a free port")),
      );
    };

    for (let index = 0; index < 2; index += 1) {
      const server = createNetServer();

      servers.push(server);
      server.on("error", fail);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo | null;

        if (address === null) {
          fail(new Error("could not resolve a free port"));

          return;
        }

        ports.push(address.port);

        if (ports.length === 2)
          closeAll(() => resolve({ vitePort: ports[0]!, hmrPort: ports[1]! }));
      });
    }
  });

// Build the Vite island Fast-Refresh dev server (DX-parity R2). OPT-IN: only when the
// project has an `app/islands/` dir AND installed the optional `@lesto/island-dev`
// peer. A missing peer (the default scaffold) → `undefined`, and `lesto dev` keeps the
// Bun island build/watch/reload path. The heavy Vite + plugin graph is reached ONLY
// through this LAZY `import`, so a default install never resolves it (the
// `@lesto/styles` precedent). The dialect rides in from the CLI core (config-derived);
// the PUBLIC_* inject map is resolved here, the same one the Bun build inlines.
const buildIslandDev = async (dialect: UiDialect): Promise<IslandDevServer | undefined> => {
  if (!(await dirExists(islandsDir))) return undefined;

  // The opt-in gate: the app's OWN package.json must declare `@lesto/island-dev`. Mere
  // resolvability is not enough — inside this monorepo (and the scaffold-loop e2e, which
  // links the whole workspace node_modules) the peer always imports, so gating on the
  // import alone would hijack every in-repo app's `lesto dev`. See `declaresIslandDevPeer`.
  if (!(await appDeclaresIslandDev())) return undefined;

  const islandDevModule = await loadIslandDevPeer();

  if (islandDevModule === undefined) return undefined;

  const publicEnvDefine = await resolvePublicEnvDefine();
  const { vitePort, hmrPort } = await findIslandDevPorts();

  return islandDevModule.createIslandDevServer(
    {
      root: projectRoot,
      islandsDir,
      dialect,
      vitePort,
      hmrPort,
      ...(publicEnvDefine === undefined ? {} : { publicEnvDefine }),
    },
    islandDevModule.viteIslandDevDeps(projectRoot),
  );
};

// Lazy-import the optional `@lesto/island-dev` peer, or `undefined` when it is not
// installed (the default scaffold). The literal specifier stays so the resolved
// module's types flow to `buildIslandDev`'s call sites; the return type is INFERRED
// (not a written `import()` annotation), keeping the lint rule satisfied. ONLY "the
// peer itself isn't resolvable" is swallowed — a genuine error INSIDE an installed
// `@lesto/island-dev` (a broken transitive, a removed `@lesto/assets` export, a bad
// publish) must surface, not be masked as "peer absent" (a dev who installed it for
// Fast Refresh would otherwise silently get nothing). Mirrors
// `rethrowUnlessMissingContentPeer`: classify on the MISSING specifier, not the whole
// message (which also embeds the importer path).
// Whether the app opted into island Fast Refresh by DECLARING `@lesto/island-dev` in
// its own `package.json`. A missing/unparseable file → not opted in (the default
// scaffold). The declaration test is the pure, covered `declaresIslandDevPeer`; this is
// only the fs read (a no package.json app falls back to the Bun reload path).
const appDeclaresIslandDev = async (): Promise<boolean> => {
  try {
    return declaresIslandDevPeer(
      JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")),
    );
  } catch {
    return false;
  }
};

const loadIslandDevPeer = async () => {
  try {
    return await import("@lesto/island-dev");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      const missing = /Cannot find (?:package|module) '([^']+)'/.exec(error.message)?.[1];

      if (missing === "@lesto/island-dev") return undefined;
    }

    throw error;
  }
};

// Whether the project's resolved Tailwind CSS entry exists (ADR 0037). The CLI core
// names the project-relative entry (`ui.css`, default `app/styles/app.css`); this
// resolves it against the project root and probes the real filesystem. Absent → the
// CSS build is skipped (Tailwind stays opt-in), exactly as a missing `app/islands/`
// skips the client build.
const cssEntryExists = (entry: string): Promise<boolean> => dirExists(join(projectRoot, entry));

// Build the Tailwind v4 stylesheet with @lesto/styles. The native engine
// (`@tailwindcss/node` + `@tailwindcss/oxide`) is heavy and OFFICIALLY internal, so
// `@lesto/styles` is an OPTIONAL peerDependency reached ONLY through this LAZY
// `await import("@lesto/styles")` — guarded upstream by `cssEntryExists`, so an app
// that uses no Tailwind never resolves it and the native binaries never enter the
// CLI's eager graph (the `@lesto/content-core` precedent). The literal specifier
// stays so the resolved module's types flow to `buildStyles`/`tailwindStyleCompiler`.
// `resolveBase` (the project root, where `@import "tailwindcss"` resolves) and
// `scanRoot` (the `app/` source Tailwind scans) are the engine's two distinct roots.
const buildAppStyles = async (options: {
  entry: string;
  outDir: string;
  mode: "dev" | "production";
  scanRoot: string;
}): Promise<void> => {
  const { buildStyles, tailwindStyleCompiler } = await import("@lesto/styles");

  await buildStyles(
    {
      entry: join(projectRoot, options.entry),
      outDir: join(projectRoot, options.outDir),
      mode: options.mode === "dev" ? "development" : "production",
      report: (line) => console.log(line),
    },
    // `scanRoot` is the project-relative dir Tailwind scans (`ui.cssScanRoot`, default
    // `app/`); an app with markup outside `app/` (a docs/marketing site under `src/`)
    // points it there so its classes are compiled in.
    tailwindStyleCompiler({
      resolveBase: projectRoot,
      scanRoot: join(projectRoot, options.scanRoot),
    }),
  );
};

// Watch a directory tree recursively and fire `onChange` at most once per debounce
// window, so a burst of saves coalesces into a single rebuild. Returns a stop handle.
const watchDir = (dir: string, onChange: () => void): (() => void) => {
  const watcher = watch(dir, { recursive: true });

  let timer: ReturnType<typeof setTimeout> | undefined;

  watcher.on("change", () => {
    clearTimeout(timer);

    timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
  });

  return () => {
    clearTimeout(timer);
    watcher.close();
  };
};

// Watch `app/islands/` for the island client rebuild (ADR 0011).
const watchIslands = (onChange: () => void): (() => void) => watchDir(islandsDir, onChange);

// Watch the WHOLE `app/` tree for the Tailwind CSS rebuild (ADR 0037 TW4): classes
// appear in routes and components too, not just islands, so this is broader than
// `watchIslands` — a class edit anywhere triggers a CSS rebuild + stylesheet hot-swap.
const watchStyleSources = (onChange: () => void): (() => void) => watchDir(appSrcDir, onChange);

// The dev live-reload WebSocket port — fixed so the injected client script knows
// where to connect (a separate port from the HTTP server keeps the reload channel
// off the app's own request surface). The bin runs under Bun, whose built-in
// `Bun.serve` carries a WebSocket server, so this needs no `ws` dependency.
const LIVE_RELOAD_PORT = 35729;

// Build the dev live-reload channel: a Bun WebSocket server, the client snippet to
// inject into dev HTML, and the broadcast/close handles `run` orchestrates. The
// client opens the socket and, per message, either RELOADS (a successful change, or a
// dropped connection so a dev-server restart reloads too) or paints a full-screen
// ERROR OVERLAY (a build/reload failure the core pushed via `notifyError`). All
// wiring — coverage-excluded like the rest of the bin; the decision of WHEN to
// inject / notify / notifyError is in the covered core. The overlay renders every
// dynamic field with `textContent` (never `innerHTML`), so an error message that
// contains markup cannot inject into the page.
const buildLiveReload = (): {
  script: string;
  notify: () => void;
  notifyError: (error: DevError) => void;
  notifyStyleUpdate: () => void;
  close: () => void;
} => {
  const sockets = new Set<{ send: (data: string) => void }>();

  // `Bun` is the runtime this bin is spawned under (the shebang + the e2e). Typed
  // loosely here (no `@types/bun` in this package) — it is irreducible wiring.
  const bun = (globalThis as { Bun?: BunLike }).Bun;

  let server: { stop?: () => void } | undefined;

  try {
    server = bun?.serve({
      port: LIVE_RELOAD_PORT,
      // Bind loopback-only to MATCH the app server (`run.ts` listens on 127.0.0.1).
      // Bun's default is all interfaces (0.0.0.0); on shared Wi-Fi that would let any
      // LAN peer connect to the reload socket and observe reload + error-overlay
      // payloads (local source paths, stack frames). The app is loopback-only, so the
      // page can only ever be reached at localhost — the WS never needs to be wider.
      hostname: "127.0.0.1",
      fetch(_request: unknown, srv: { upgrade: (request: unknown) => boolean }) {
        // Every request to this port is a WS upgrade; a non-upgrade gets a 426.
        if (srv.upgrade(_request)) return undefined;

        return new Response("expected a websocket upgrade", { status: 426 });
      },
      websocket: {
        open(ws: { send: (data: string) => void }) {
          sockets.add(ws);
        },
        close(ws: { send: (data: string) => void }) {
          sockets.delete(ws);
        },
        message() {
          // The client never sends; ignore anything it does.
        },
      },
    });
  } catch {
    // A busy reload port (a second dev server, a leftover socket) must not crash the
    // dev boot — live reload just stays off; the HTTP server still serves.
    server = undefined;
  }

  // The injected client (see `dev-overlay.ts`): connect to the reload socket; on a
  // `reload` message (or a dropped connection) reload the page, on an `error` message
  // paint the overlay. Extracted to a pure builder so its DOM rendering is unit-tested
  // against a fake socket — this bin injects exactly that tested output.
  const script = devReloadClientScript(LIVE_RELOAD_PORT);

  return {
    script,
    notify: () => {
      for (const ws of sockets) ws.send('{"type":"reload"}');
    },
    notifyError: (error: DevError) => {
      // Discriminant LAST so it is authoritative — a future `DevError` field named
      // `type` can never spread over it and mis-route an error as a reload.
      const data = JSON.stringify({ ...error, type: "error" });

      for (const ws of sockets) ws.send(data);
    },
    notifyStyleUpdate: () => {
      // The client swaps the stylesheet `<link>` in place (no reload) on this frame
      // — a CSS edit keeps island/page state (ADR 0037 TW4).
      for (const ws of sockets) ws.send('{"type":"style-update"}');
    },
    close: () => {
      server?.stop?.();
    },
  };
};

/** The slice of Bun's runtime API the live-reload server uses — typed loosely (irreducible wiring). */
interface BunLike {
  serve: (options: unknown) => { stop?: () => void } | undefined;
}

// The content (CMS) packages are OPTIONAL PEERS: a default scaffold uses only
// `dev`/`build`/`serve`/`routes`, so it never installs `@lesto/content-core` or
// `@lesto/content-store` and they must not be pulled in at module init. The
// `content:*` commands dynamic-import them ON CALL, and a missing peer surfaces
// as a friendly, coded message — `npm i @lesto/content-core @lesto/content-store`
// — rather than a raw `MODULE_NOT_FOUND`.
const CONTENT_PACKAGES_HINT =
  "The `content:*` commands need the content packages — run " +
  "`npm i @lesto/content-core @lesto/content-store`.";

// Convert ONLY "the content peer itself isn't installed" into the hint; rethrow anything
// else — a real error INSIDE an installed content package (e.g. its own undeclared
// transitive dep) must NOT be masked as "go install it", which would send the operator
// down the wrong path. Node's `ERR_MODULE_NOT_FOUND` message embeds the IMPORTER's path
// (`Cannot find package '<missing>' imported from '<importer>'`), so we classify on the
// extracted MISSING specifier — not the whole message, which would also match the importer
// path of a missing transitive dep. Mirrors `loadSites` anchoring on its exact filename.
function rethrowUnlessMissingContentPeer(error: unknown): never {
  if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
    const missing = /Cannot find (?:package|module) '([^']+)'/.exec(error.message)?.[1];

    if (missing?.startsWith("@lesto/content-")) {
      throw new CliError("CLI_CONTENT_PACKAGES_MISSING", CONTENT_PACKAGES_HINT);
    }
  }

  throw error;
}

// The literal import specifiers stay (a variable specifier would infer `any`), so the
// resolved module types still flow to the lazy `runPipeline`/`persistEntries` calls below.
const loadContentCore = async () => {
  try {
    return await import("@lesto/content-core/build");
  } catch (error) {
    rethrowUnlessMissingContentPeer(error);
  }
};

const loadContentStore = async () => {
  try {
    return await import("@lesto/content-store");
  } catch (error) {
    rethrowUnlessMissingContentPeer(error);
  }
};

// Run the pipeline for its entries; the project's lesto.app.ts owns the cwd and
// the collections, so the bin needs no arguments here. Content-core loads
// lazily, only when a `content:*` command actually runs.
const buildContent = async (): Promise<readonly RuntimeEntry[]> =>
  (await (await loadContentCore()).runPipeline({ skipWrite: true })).entries;

// The project's content collections, for the agent artifacts' inventory (`generate
// agents`). Sources them the way the app's OWN code does (e.g. `site/src/content.ts`):
// load `lesto.content.ts` and run the build pipeline, so the artifact lists exactly the
// collections the app builds from, with accurate per-collection entry counts. A project
// with NO `lesto.content.ts` is content-free — yield an empty run (the reader groups it
// to no collections); a genuine pipeline THROW (an unreadable content file, a missing
// `@lesto/content-core` peer) propagates to the reader's `onError` sink rather than being
// mistaken for "no content". (A schema-invalid entry is dropped with its own warning by
// the pipeline — it lowers a count, not an `onError`.)
const CONTENT_CONFIG_PATH = join(projectRoot, "lesto.content.ts");

const readContentConfig = async (): Promise<{ entries: readonly RuntimeEntry[] }> => {
  // `dirExists` is a bare existence probe (works for a file too): no config → no content.
  if (!(await dirExists(CONTENT_CONFIG_PATH))) return { entries: [] };

  const { default: config } = (await import(CONTENT_CONFIG_PATH)) as { default: EngineConfig };
  const { runPipeline } = await loadContentCore();

  return runPipeline({ cwd: projectRoot, config, skipWrite: true });
};

const createEntry = async (collection: string, title: string): Promise<void> =>
  (await loadContentCore()).createNewEntry(process.cwd(), collection, title);

// The content-store writers, each dynamic-importing `@lesto/content-store` on
// call so the optional peer stays out of a default install's boot graph.
const persistEntries: CliDeps["persistEntries"] = async (db, entries) =>
  (await loadContentStore()).persistEntries(db, entries);

const pruneEntries: CliDeps["pruneEntries"] = async (db, keep) =>
  (await loadContentStore()).pruneEntries(db, keep);

const deleteEntry: CliDeps["deleteEntry"] = async (db, collection, id) =>
  (await loadContentStore()).deleteEntry(db, collection, id);

// The project declares its sites in `lesto.sites.ts`, mirroring `lesto.app.ts`;
// the build reads its default export. A MISSING file is tolerated, not fatal: it
// resolves to no sites, and the CLI core falls back to app-only dispatch (a fresh
// scaffold boots before its author writes a sites file — blocker #9). Any OTHER
// import error (a syntax error in an existing file) is rethrown, so a real bug in
// the sites file is not silently swallowed as "no sites".
//
// The raw default export is run through `defineSites` HERE — not just trusted — so
// the name/basePath invariants are enforced on the live load path, the chokepoint
// every consumer (build, serve, deploy) reads from. A hand-built `Site[]` that
// skips `defineSites` in the config (e.g. `export default [...]`) is still
// validated, so a `../../`-shaped name can never reach `cleanDir`/the build-hook
// sink, which root a path AT `out/<name>` (defense-in-depth, ADR 0038 review).
const SITES_PATH = join(process.cwd(), "lesto.sites.ts");

const loadSites = async (): Promise<readonly Site[]> => {
  // `lesto.sites.ts` is OPTIONAL — an app with none dispatches every path to its own
  // handle. Probe existence FIRST rather than rely on `import()` THROWING for an absent
  // file: under the bin's jiti loader a missing-module import HANGS (never resolves,
  // never throws) instead of raising ERR_MODULE_NOT_FOUND, so the prior throw-and-catch
  // shape blocked `lesto dev`/`serve`/`build` FOREVER when the (documented-optional)
  // file was absent. `dirExists` is a bare existence probe (works for a file too) — the
  // same probe-first shape `readContentConfig` already uses for `lesto.content.ts`.
  if (!(await dirExists(SITES_PATH))) return [];

  try {
    const module = (await import(SITES_PATH)) as { default: readonly Site[] };

    return defineSites(module.default);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      // The file existed at the probe but a module it imports is missing — only the
      // sites file itself being absent is tolerated (handled above); a missing
      // transitive import is a real error. (A delete between probe and import lands
      // here too, and returning empty is the right tolerant answer.)
      if ((error as { message: string }).message.includes("lesto.sites.ts")) return [];
    }

    throw error;
  }
};

// The project's optional post-build hook, mirroring `lesto.sites.ts`: `lesto.build.ts`
// default-exports an `onBuilt` function that `lesto build` fires after prerender +
// client + styles. A MISSING file is tolerated (→ undefined, no hook); any OTHER import
// error (a syntax error in an existing file, or a missing transitive import) is rethrown
// so a real bug is not swallowed as "no hook".
const BUILD_HOOK_PATH = join(projectRoot, "lesto.build.ts");

const loadBuildHook = async (): Promise<BuildHook | undefined> => {
  // Same probe-first guard as `loadSites`: `lesto.build.ts` is OPTIONAL, and the bin's
  // jiti loader HANGS on a missing-module `import()` rather than throwing — so an absent
  // hook would block `lesto build` forever. Probe before importing.
  if (!(await dirExists(BUILD_HOOK_PATH))) return undefined;

  try {
    const module = (await import(BUILD_HOOK_PATH)) as { default: BuildHook };

    return module.default;
  } catch (error) {
    if (isMissingBuildHook(error)) return undefined;

    throw error;
  }
};

// Classify an `import()` failure as "the hook file itself is absent" (→ no hook) vs.
// any real error inside an existing file (a syntax error, a missing transitive import),
// which must fail the build LOUD. Two cross-runtime hazards drive the exact shape here:
//
//   1. NOT `instanceof Error`: under Bun a missing-module import throws a `ResolveMessage`
//      that is NOT an `Error` instance (only its `code`/`message` are reliable), so gating
//      on `instanceof Error` would mis-rethrow an absent hook as a fatal build failure. We
//      duck-type on `code` + `message` instead, which holds under both Node and Bun.
//   2. Classify on the MISSING SPECIFIER, not the whole message: a missing TRANSITIVE
//      import's message embeds the IMPORTER's path (`Cannot find module '<dep>' from
//      '<importer>'`), so an importer of `lesto.build.ts` would match a naive
//      `message.includes("lesto.build.ts")` and wrongly be swallowed. Anchoring on the
//      extracted missing specifier — only the absent hook FILE names `lesto.build.ts` as
//      the missing module — rethrows a transitive miss. (Mirrors `rethrowUnlessMissingContentPeer`.)
function isMissingBuildHook(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    (error as { code?: unknown }).code !== "ERR_MODULE_NOT_FOUND" ||
    !("message" in error)
  ) {
    return false;
  }

  const missing = /Cannot find (?:package|module) '([^']+)'/.exec(
    String((error as { message: unknown }).message),
  )?.[1];

  return missing !== undefined && missing.endsWith("lesto.build.ts");
}

// Remove the output dir before a build, so a route deleted since the last build leaves
// no orphan the deploy still ships (the sink only writes). `force` tolerates the first
// build, when the dir does not yet exist.
const cleanDir = (dir: string): Promise<void> =>
  rm(join(projectRoot, dir), { recursive: true, force: true });

const [command, ...commandArgs] = argv;

// `mcp` and `openapi` live in their own command files (operability-dx #4/#5);
// the bin dispatches them here, before the shared `run` core, because they bring
// dependencies (`@lesto/mcp`, `@lesto/openapi`) the rest of the CLI does not. The
// MCP protocol owns stdout (it is the transport), so its logs and audit trail go
// to stderr.
if (command === "mcp") {
  await runMcp(commandArgs, {
    loadApp,
    createApp,
    startMcpServer,
    audit: console.error,
    log: console.error,
  });

  // The MCP server runs until its stdio transport closes; `runMcp` resolves then.
  process.exit(0);
}

if (command === "openapi") {
  const exit = await runOpenApi(commandArgs, {
    loadApp,
    write: (path, contents) => writeFile(path, contents, "utf8"),
    out: console.log,
  });

  process.exit(exit);
}

// The project-rooted filesystem seam every `generate` flavor shares: an `exists`
// probe (for idempotency / drift), a reader (to tell "unchanged" from "differs"),
// and a parent-dir-creating writer. Each path is absolute against the project root,
// so files land in the project regardless of cwd.
const generateIO: GenerateIO = {
  exists: async (path) => {
    try {
      await access(join(projectRoot, path));

      return true;
    } catch {
      return false;
    }
  },
  read: (path) => readFile(join(projectRoot, path), "utf8"),
  write: async (path, contents) => {
    const absolute = join(projectRoot, path);

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  },
};

// `generate` (alias `g`) scaffolds a resource (ADR 0019). It lives here, before
// the shared `run` core, because it brings its own filesystem seam (`generateIO`).
if (command === "generate" || command === "g") {
  // `generate agents` (`g agents`) is a WHOLE-APP generator: it scans the app's
  // conventions into `AGENTS.md` + `llms.txt` (ADR 0035) rather than scaffolding one
  // named resource, so it has its own orchestrator and is intercepted here before
  // the per-resource `runGenerate` (whose generator set would reject `agents`). The
  // route + island readers are the real `fs` scans; content collections come from
  // running the content pipeline over `lesto.content.ts` (empty when the app has no
  // content config), with a genuine pipeline failure surfaced to stderr. The UI
  // dialect is omitted on purpose: the artifacts stay useful without evaluating
  // `lesto.app.ts` (and its boot side effects) just to stamp a dialect line.
  if (commandArgs[0] === "agents") {
    const exit = await runGenerateAgents(commandArgs.slice(1), {
      ...generateIO,
      readRoutes: readAgentRoutes,
      readIslands: readAgentIslands,
      readCollections: createCollectionsReader(readContentConfig, (error) =>
        console.warn(`lesto: content collections unavailable — ${String(error)}`),
      ),
      summary: { framework: "lesto" },
      out: console.log,
    });

    process.exit(exit);
  }

  const exit = await runGenerate(commandArgs, {
    ...generateIO,
    now: Date.now,
    out: console.log,
  });

  process.exit(exit);
}

// The live-reload socket is opened ONLY for `dev` — no other command needs it, and
// no command should leave a socket bound. Built here so its handle (notify/close)
// rides into `run` for the dev loop to drive.
const liveReload = command === "dev" ? buildLiveReload() : undefined;

// The Vite island Fast-Refresh server is wired ONLY for `dev` (DX-parity R2). A
// factory, not a built value: the dialect it needs is config-derived, resolved inside
// the dev loop, which calls this with it. Off for every other command.
const islandDev =
  command === "dev"
    ? (request: { dialect: UiDialect }) => buildIslandDev(request.dialect)
    : undefined;

const code = await run(argv, {
  loadApp,
  serve,
  buildContent,
  persistEntries,
  pruneEntries,
  deleteEntry,
  createEntry,
  loadSites,
  loadBuildHook,
  cleanDir,
  sink: nodeSink,
  readAsset: nodeStaticReader(join(process.cwd(), DEV_ASSET_DIR)),
  hasIslandsDir,
  buildClientAssets,
  resolvePublicEnvDefine,
  cssEntryExists,
  buildAppStyles,
  watchIslands,
  watchStyleSources,
  watchRoutes,
  reloadApp,
  regenerateRoutes,
  ...(liveReload === undefined ? {} : { liveReload }),
  ...(islandDev === undefined ? {} : { islandDev }),
  uploader: nodeUploader,
  releaseStore,
  now: Date.now,
  cloudflare: wranglerDeployer,
  checkHealth: httpHealthCheck,
  // On a deploy's rolling restart, drain in-flight requests then exit cleanly.
  installShutdown: (drain) => {
    const shutdown = (): void => {
      void drain().then(() => process.exit(0));
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  },
  out: console.log,
});

// Long-running commands keep the process alive on their own socket; everything
// else has said all it has to say, so exit with the code the core returned.
if (argv[0] !== "serve" && argv[0] !== "dev") process.exit(code);
