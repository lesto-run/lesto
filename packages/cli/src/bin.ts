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
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, join } from "node:path";

import { nodeStaticReader, serve } from "@lesto/runtime";
import type { LestoAppConfig } from "@lesto/kernel";
import { scanRoutes } from "@lesto/router";
import { applyFileRoutes, generateRouteManifest, loadFileRoutes } from "@lesto/web";
import type { UiDialect } from "@lesto/web";
import type { TraceSeams } from "@lesto/observability";

import type { RuntimeEntry } from "@lesto/content-core";

import { nodeSink } from "@lesto/sites";
import type { Site } from "@lesto/sites";

import { nodeReleaseStore, nodeUploader, remoteReleaseStore } from "@lesto/deploy";
import type { ReleaseStore } from "@lesto/deploy";

import { buildClient, bunBuildClientDeps } from "@lesto/assets";

import { createApp } from "@lesto/kernel";

import { run } from "./run";
import type { CliDeps, CloudflareDeployer, DevError, ReleaseTarget } from "./run";
import { CliError } from "./errors";
import { WRANGLER_DEPLOY_ARGS, WRANGLER_ROLLBACK_MESSAGE, wranglerRollbackArgs } from "./wrangler";
import { runMcp, startMcpServer } from "./mcp";
import { runOpenApi } from "./openapi";
import { runGenerate } from "./generate";

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

/** Debounce window for the dev island watcher: coalesce a burst of saves into one rebuild. */
const WATCH_DEBOUNCE_MS = 100;

const argv = process.argv.slice(2);

const projectRoot = process.cwd();

const islandsDir = join(projectRoot, ISLANDS_DIR);

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
}): Promise<void> => {
  await buildClient(
    {
      islandsDir,
      outDir: join(projectRoot, options.outDir),
      mode: options.mode === "dev" ? "development" : "production",
      dialect: options.dialect,
    },
    bunBuildClientDeps(projectRoot),
  );
};

// Watch `app/islands/` and fire `onChange` at most once per debounce window, so
// a burst of saves coalesces into a single rebuild. Returns a stop handle.
const watchIslands = (onChange: () => void): (() => void) => {
  const watcher = watch(islandsDir, { recursive: true });

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

  // The injected client: connect to the reload socket; on a `reload` message (or a
  // dropped connection) reload the page, on an `error` message paint the overlay.
  // Every dynamic field is set via `textContent`, so the error text is inert markup —
  // no escaping, no injection. Inlined so no asset fetch is needed and it runs the
  // moment the document parses. `${LIVE_RELOAD_PORT}` is the only interpolation.
  const script = `(()=>{try{
const ID="__lesto_dev_overlay__";
const clear=()=>{const el=document.getElementById(ID);if(el)el.remove();};
const sty=(el,css)=>el.setAttribute("style",css);
const show=(d)=>{clear();
const o=document.createElement("div");o.id=ID;
sty(o,"position:fixed;inset:0;z-index:2147483647;background:rgba(8,8,12,.94);color:#f4f4f5;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;padding:6vh 24px;overflow:auto;");
const card=document.createElement("div");sty(card,"max-width:940px;margin:0 auto;");
const tag=document.createElement("div");sty(tag,"color:#ff7b7b;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:14px;");
tag.textContent="lesto dev — "+(d.source||"error");
const msg=document.createElement("div");sty(msg,"font-size:16px;color:#ffe1e1;white-space:pre-wrap;margin-bottom:18px;");
msg.textContent=d.message||"Unknown dev error";
card.appendChild(tag);card.appendChild(msg);
if(d.stack){const pre=document.createElement("pre");sty(pre,"white-space:pre-wrap;color:#d4d4d8;background:rgba(255,255,255,.06);padding:16px;border-radius:8px;overflow:auto;margin:0;");pre.textContent=d.stack;card.appendChild(pre);}
const hint=document.createElement("div");sty(hint,"margin-top:18px;color:#8a8a93;");
hint.textContent="Fix and save — this clears on the next successful build. Press Esc to dismiss.";
card.appendChild(hint);o.appendChild(card);(document.body||document.documentElement).appendChild(o);};
addEventListener("keydown",(e)=>{if(e.key==="Escape")clear();});
const c=()=>{const s=new WebSocket("ws://"+location.hostname+":${LIVE_RELOAD_PORT}");
s.onmessage=(e)=>{let d;try{d=JSON.parse(e.data);}catch{location.reload();return;}if(d&&d.type==="error")show(d);else location.reload();};
s.onclose=()=>setTimeout(c,1000);};c();
}catch{}})();`;

  return {
    script,
    notify: () => {
      for (const ws of sockets) ws.send('{"type":"reload"}');
    },
    notifyError: (error: DevError) => {
      const data = JSON.stringify({ type: "error", ...error });

      for (const ws of sockets) ws.send(data);
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
const SITES_PATH = join(process.cwd(), "lesto.sites.ts");

const loadSites = async (): Promise<readonly Site[]> => {
  try {
    const module = (await import(SITES_PATH)) as { default: readonly Site[] };

    return module.default;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      // Distinguish "the sites file is absent" from "a module it imports is
      // missing": only the former — the sites file itself not existing — is the
      // tolerated empty-sites case. A missing transitive import is a real error.
      if ((error as { message: string }).message.includes("lesto.sites.ts")) return [];
    }

    throw error;
  }
};

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

// `generate` (alias `g`) scaffolds a resource (ADR 0019). It lives here, before
// the shared `run` core, because it brings its own filesystem seam: an `exists`
// probe (for idempotency) and a parent-dir-creating `write`. Both are absolute
// against the project root, so the files land in the project regardless of cwd.
if (command === "generate" || command === "g") {
  const exit = await runGenerate(commandArgs, {
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
    now: Date.now,
    out: console.log,
  });

  process.exit(exit);
}

// The live-reload socket is opened ONLY for `dev` — no other command needs it, and
// no command should leave a socket bound. Built here so its handle (notify/close)
// rides into `run` for the dev loop to drive.
const liveReload = command === "dev" ? buildLiveReload() : undefined;

const code = await run(argv, {
  loadApp,
  serve,
  buildContent,
  persistEntries,
  pruneEntries,
  deleteEntry,
  createEntry,
  loadSites,
  sink: nodeSink,
  readAsset: nodeStaticReader(join(process.cwd(), DEV_ASSET_DIR)),
  hasIslandsDir,
  buildClientAssets,
  watchIslands,
  watchRoutes,
  reloadApp,
  regenerateRoutes,
  ...(liveReload === undefined ? {} : { liveReload }),
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
