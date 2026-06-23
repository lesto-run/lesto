/**
 * The CLI's pure command core.
 *
 * `run` is the whole brain of the `lesto` tool, with every real-world dependency
 * injected: how to load the project's app, how to serve it, and where output
 * goes. That seam is what makes the core fully testable — a test hands `run` a
 * fake `loadApp`, a spy `serve`, and a capturing `out`, and asserts on exactly
 * what was printed and called, with no filesystem, no sockets, and no process.
 *
 * The thin `bin.ts` builds the real dependencies (a dynamic import of the
 * project's `lesto.app.ts`, the real `@lesto/runtime` serve, `console.log`) and
 * keeps the process alive for long-running commands. Everything decided here is
 * covered; only that wiring is excluded.
 */

import { createApp } from "@lesto/kernel";
import type { LestoAppConfig, KernelDatabase } from "@lesto/kernel";
import { currentRequestSpan } from "@lesto/web";
import type { HandleOptions, LestoResponse, UiDialect } from "@lesto/web";

import { parseTraceparent, tracesFromEnv } from "@lesto/observability";
import type { CurrentSpan, TraceSeams, Traces, TracesEnv } from "@lesto/observability";

import type { deleteEntry, persistEntries, pruneEntries } from "@lesto/content-store";
import type { RuntimeEntry } from "@lesto/content-core";

import { buildStaticSites } from "@lesto/sites";
import type { OutputSink, Site } from "@lesto/sites";

import { dispatchSitesDev } from "@lesto/runtime";
import type { serve, StaticReader } from "@lesto/runtime";

import { planDeploy, rollback, shipRelease, shipStatic } from "@lesto/deploy";
import type { ReleaseStore, ShipDeps } from "@lesto/deploy";

import { CliError } from "./errors";
import { parsePort, parseStringFlag } from "./flags";

/** The default port for `serve`/`dev` when no `--port` flag is given. */
const DEFAULT_PORT = 3000;

/**
 * Where a release publishes — the discriminated target the `releaseStore` seam
 * builds a {@link ReleaseStore} from.
 *
 * `local` is the on-disk store (`releases/<version>/` trees under `--dist` behind
 * an atomically-renamed `current` symlink). `remote` is the same versioned
 * machinery over a generic S3-compatible object store (Cloudflare R2, AWS S3,
 * MinIO): the core resolves the bucket *addressing* from flags, while the
 * **credentials** stay in the environment — the bin reads them when it builds the
 * store, so a secret never rides a flag, a log line, or an error's details.
 */
export type ReleaseTarget =
  | { readonly kind: "local"; readonly distDir: string }
  | {
      readonly kind: "remote";

      /** Service endpoint origin, e.g. `https://<account>.r2.cloudflarestorage.com`. */
      readonly endpoint: string;

      /** The bucket releases publish into. */
      readonly bucket: string;

      /** The signing region — `auto` for R2, e.g. `us-east-1` for S3. */
      readonly region: string;

      /** A custom live-pointer key, so one bucket can host several sites. */
      readonly pointerKey?: string;
    };

/**
 * How often `serve`/`dev` flush buffered spans to the collector when tracing is
 * on. A long-lived node service flushes on a steady cadence (and once more on
 * drain) — five seconds keeps the collector close to live without a request per
 * span. The interval is `unref`'d (see {@link Traces.startInterval}) so it never
 * holds the process open on its own.
 */
const TRACE_FLUSH_INTERVAL_MS = 5_000;

/**
 * The synthetic single site `dev` falls back to when a project declares none (a
 * missing `lesto.sites.ts`): one dynamic zone at the root, so every path is
 * dispatched live to the app. The whole-app, no-zones default — the scaffold's
 * first-boot shape — instead of a hard crash or a 404 on every route (blocker #9).
 */
const APP_ONLY_SITE: Site = { name: "app", render: "dynamic", basePath: "/" };

/**
 * The Cloudflare deploy driver — the swappable edge `lesto deploy --cloudflare`
 * pushes a Worker (and its bound Static Assets) through.
 *
 * Deploying to a specific platform is an irreducible edge — the platform owns the
 * upload protocol and it moves — so Lesto drives a thin driver here rather than
 * reimplementing it (ADR 0015). The bin wires this to the official `wrangler`
 * CLI today; because the CLI core only ever sees this interface, a future
 * direct-Cloudflare-API client (no spawned binary — for the agent control plane)
 * is a drop-in replacement that needs no change to `runDeploy`.
 */
export interface CloudflareDeployer {
  /**
   * Deploy the Worker and its bound Static Assets (the driver reads the
   * project's `wrangler.jsonc`). Returns the live `url` when the driver can
   * determine it, so the deploy can be health-gated before it is trusted.
   */
  deploy: () => Promise<{ readonly url: string | undefined }>;

  /** Roll the Worker back to its previous deployment — the one-step undo. */
  rollback: () => Promise<void>;
}

/**
 * The outcome of regenerating the edge route manifest — the path it wrote and how
 * many convention files (pages, layouts, boundaries) it scanned. `lesto routes:gen`
 * prints both; `dev`'s on-change refresh logs the count.
 */
export interface RegenerateRoutesResult {
  /** The manifest path written, relative to the project root (e.g. `src/routes.gen.ts`). */
  readonly path: string;

  /** The number of convention files the scan found (page + layout + boundary). */
  readonly count: number;
}

/**
 * Which dev step broke what the author is looking at — the overlay's heading and the
 * hint to where to look. `client-rebuild` = the island bundle; `app-reload` =
 * re-importing the app/route modules (the classic "syntax error in a just-saved
 * page"). A failed edge route-manifest regen is NOT here: it leaves the running dev
 * page working (it is only the Worker's static-import map), so it stays a stderr line.
 * `style-rebuild` = the Tailwind CSS rebuild (ADR 0037 TW4) — a bad `@theme`/`@import`
 * surfaces as the overlay too, cleared by the next successful build.
 */
export type DevErrorSource = "client-rebuild" | "app-reload" | "style-rebuild";

/**
 * A dev build/reload failure pushed to the open browser so `lesto dev` renders an
 * in-page error overlay instead of leaving the author to find it on stderr.
 * `message` is the author-facing error (the bundler/loader message, via
 * {@link rebuildErrorMessage}); `stack` is the underlying cause's stack when present.
 */
export interface DevError {
  readonly source: DevErrorSource;

  readonly message: string;

  readonly stack?: string;
}

/**
 * The dev live-reload channel (Workstream 3) — a WebSocket the bin runs beside the
 * dev HTTP server, so a saved page/layout/route reloads the open browser.
 *
 * The bin owns the socket and exposes four things; the CLI core decides when to
 * use them. `script` is the client snippet the core injects into every dev HTML
 * response (it connects to the socket and calls `location.reload()` on a message).
 * `notify()` broadcasts a reload to every connected browser (the core calls it after
 * a watched change SUCCEEDS). `notifyError()` broadcasts a build/reload FAILURE,
 * which the client renders as a full-screen overlay (so the error no longer hides on
 * stderr); the next successful change's `notify()` reload clears it. `close()` tears
 * the socket down on shutdown.
 */
export interface LiveReload {
  /** The client JS injected into dev HTML — opens the socket, reloads on a message. */
  readonly script: string;

  /** Broadcast a reload to every connected browser (a watched change succeeded). */
  readonly notify: () => void;

  /**
   * Broadcast a build/reload FAILURE to every connected browser, which renders it
   * as a full-screen dev error overlay. The next successful change calls
   * {@link notify} — a reload that clears the overlay.
   */
  readonly notifyError: (error: DevError) => void;

  /**
   * Broadcast a stylesheet HOT-SWAP to every connected browser (a watched CSS
   * rebuild succeeded, ADR 0037 TW4). The client swaps the `<link href="/styles.css">`
   * in place with a cache-busted href and does NOT reload — so island and page state
   * survive a style edit. Distinct from {@link notify}, which performs a full reload.
   */
  readonly notifyStyleUpdate: () => void;

  /** Shut the live-reload socket down (called on graceful dev shutdown). */
  readonly close: () => void;
}

/** The seams the command core depends on — all injected, never imported live. */
export interface CliDeps {
  /**
   * Load the project's app config (the bin reads `lesto.app.ts`; tests fake it).
   *
   * The code-first `lesto()` app shape ({@link LestoAppConfig}) — the only shape
   * `createApp` accepts now that the legacy `{ router, controllers }` surface is
   * gone (ADR 0004 Phase 7.6).
   *
   * `seams` is the optional tracing instrumentation the long-lived `serve`/`dev`
   * commands hand in when `LESTO_OTLP_URL` is set: a project whose `lesto.app.ts`
   * default-exports a CONFIG FACTORY (`(seams?) => LestoAppConfig`) threads the
   * `db.onQuery` hook into its own `createDb(handle, { onQuery: seams.onQuery })`,
   * so a query run during a request becomes a `db.query` CHILD span of the request
   * span — the served path's equivalent of the integration harness's wiring. A
   * project that default-exports a plain config (or a `loadApp` that ignores the
   * arg) is unchanged: absent seams (tracing off) it is never called, so there is
   * zero overhead and no behaviour change when tracing is off. The bin forwards
   * the seams to a factory export and ignores them for a plain-config export.
   */
  loadApp: (seams?: TraceSeams) => Promise<LestoAppConfig>;

  /** Stand a real server in front of the app (the bin passes `@lesto/runtime`'s). */
  serve: typeof serve;

  /**
   * Run the content pipeline and return its entries (the bin passes
   * `@lesto/content-core`'s `runPipeline`; tests fake it). The content commands
   * persist whatever this yields, so the filesystem-reading pipeline stays out
   * of the covered core.
   */
  buildContent: () => Promise<readonly RuntimeEntry[]>;

  /** Upsert the built entries into the content store (the bin passes `@lesto/content-store`'s `persistEntries`; tests fake it). */
  persistEntries: typeof persistEntries;

  /** Drop store rows the build no longer produces, for `--prune` (the bin passes `@lesto/content-store`'s `pruneEntries`; tests fake it). */
  pruneEntries: typeof pruneEntries;

  /** Remove one entry by its identity (the bin passes `@lesto/content-store`'s `deleteEntry`; tests fake it). */
  deleteEntry: typeof deleteEntry;

  /** Scaffold a new entry into a collection (the bin passes `createNewEntry`). */
  createEntry: (collection: string, title: string) => Promise<void>;

  /** Load the project's declared sites (the bin imports `lesto.sites.ts`'s default). */
  loadSites: () => Promise<readonly Site[]>;

  /** Build a sink rooted at `outDir` for the static build (the bin passes `nodeSink`). */
  sink: (outDir: string) => OutputSink;

  /**
   * Read a client build asset (e.g. `/client.js`) for the dev server, or absent
   * to disable asset serving. The bin passes `nodeStaticReader` over the asset
   * dir; without it, `lesto dev` still live-renders every zone — islands just show
   * their server fallback until a bundle is present.
   */
  readAsset?: StaticReader;

  /**
   * Probe whether the project has an `app/islands/` directory (ADR 0011's
   * one-island-per-file convention). When present, `build`/`dev` run the client
   * pipeline; absent, they do nothing — an island-less app is unchanged. The bin
   * passes an fs probe rooted at the project; absent, the CLI never builds
   * client assets (so tests opt in by providing it).
   */
  hasIslandsDir?: () => Promise<boolean>;

  /**
   * Build the project's island client bundle (`@lesto/assets`, ADR 0011 Seam 3).
   * The bin wires this to `buildClient(...)` with `bunBuildClientDeps` over the
   * project's `app/islands/`; the CLI core only decides WHEN to call it (a prod
   * build for `build`, an unminified one on `dev` boot + on watch) and with which
   * `dialect`. A rejected build is surfaced as a coded `CLI_CLIENT_BUILD_FAILED`.
   *
   * `dialect` is the matched pair's CLIENT half (ADR 0008): the CLI reads the
   * project's single `ui.dialect` key and passes it here AND lets `createApp` wire
   * the server renderer from the same value, so the client alias and the server
   * renderer can never diverge.
   */
  buildClientAssets?: (options: {
    outDir: string;
    mode: "dev" | "production";
    dialect: UiDialect;
  }) => Promise<void>;

  /**
   * Probe whether the project's resolved Tailwind CSS entry exists (ADR 0037).
   * The CLI core resolves the entry path from `ui.css` (default `app/styles/app.css`)
   * and asks this seam; when it answers true, `build`/`dev` run the CSS build, else
   * they skip it (Tailwind stays opt-in, gated on the entry's presence exactly as
   * the client build is gated on `app/islands/`). The bin passes an fs probe rooted
   * at the project; absent, the CLI never builds CSS (so tests opt in by providing it).
   */
  cssEntryExists?: (entry: string) => Promise<boolean>;

  /**
   * Build the project's Tailwind v4 stylesheet to `out/styles.css` (`@lesto/styles`,
   * ADR 0037). The bin wires this to a LAZY `await import("@lesto/styles")` —
   * `@lesto/styles` is an optional `peerDependency`, so the heavy `@tailwindcss/*`
   * native engine never enters the CLI's eager graph and an app that uses no
   * Tailwind never pulls it. The CLI core only decides WHEN to call it (a prod build
   * for `build`, an unminified one on `dev` boot + on watch). A rejected build is
   * surfaced as a coded `CLI_STYLES_BUILD_FAILED`.
   */
  buildAppStyles?: (options: {
    entry: string;
    outDir: string;
    mode: "dev" | "production";
  }) => Promise<void>;

  /**
   * Watch `app/islands/` and call `onChange` (debounced) when a module changes,
   * returning a stop handle. The bin wires this to a debounced `fs.watch`; the
   * CLI core just registers the rebuild. Absent → no watching (a one-shot dev
   * build on boot, no live rebuilds).
   */
  watchIslands?: (onChange: () => void) => () => void;

  /**
   * Watch the WHOLE app source tree (`app/`, not just `app/islands/`) and call
   * `onChange` (debounced) when any file changes, returning a stop handle. Broader
   * than {@link watchIslands} on purpose (ADR 0037 TW4): Tailwind classes appear in
   * routes, components, AND islands, so a class edit anywhere must rebuild the CSS.
   * The bin wires a debounced `fs.watch` over `app/`; `dev` registers the CSS rebuild
   * + stylesheet hot-swap. Absent → no CSS watching (a one-shot dev CSS build on boot).
   */
  watchStyleSources?: (onChange: () => void) => () => void;

  /**
   * Watch `app/routes/` and call `onChange` (debounced) when a page / layout /
   * boundary file changes, returning a stop handle. The bin wires a debounced
   * `fs.watch` over the convention dir; `dev` registers a closure that re-loads the
   * app (so a NEW route appears without a server restart), refreshes the edge
   * manifest (so `routes.gen.ts` stays current), and triggers a browser reload.
   * Absent → no route watching (Workstream 3 is opt-in; tests provide it). This is
   * the NODE re-scan path; it is distinct from the edge manifest below — the watcher
   * does both but they are separate concerns (the plan keeps them apart).
   */
  watchRoutes?: (onChange: () => void) => () => void;

  /**
   * Re-load the project's app from disk — a FRESH `LestoAppConfig` whose file routes
   * were re-scanned (the bin's `loadApp` runs `applyDiscoveredRoutes`, cache-busting
   * the route imports so a new or edited route file is picked up). `dev` calls this
   * on a watched route change and swaps the live server's handle to the new app, so
   * a route add shows without a restart. Absent → `dev` keeps its boot app. Distinct
   * from {@link loadApp} only in that the bin cache-busts the route imports here.
   */
  reloadApp?: () => Promise<LestoAppConfig>;

  /**
   * Regenerate the EDGE route manifest (`routes.gen.ts`) — scan `app/routes/`,
   * render it with `generateRouteManifest`, and write it. Returns the written path
   * and the file count, or `undefined` when the project has no `app/routes/` (so
   * there is nothing to generate). Backs `lesto routes:gen` AND `dev`'s on-change
   * codegen refresh. The bin wires the real fs scan + write; a test fakes it.
   *
   * This is the EDGE path — the static-import map a Worker bundles — kept separate
   * from the Node re-scan ({@link reloadApp}): the Node dev server only needs a
   * re-load to see a new route, while `routes.gen.ts` is what the edge build reads.
   * The watcher refreshes both, but they are not the same mechanism.
   */
  regenerateRoutes?: () => Promise<RegenerateRoutesResult | undefined>;

  /**
   * The dev live-reload channel — a tiny WebSocket the bin stands up alongside the
   * dev HTTP server. `script` is the client snippet injected into every dev HTML
   * response (it opens the socket and reloads on a message); `notify()` broadcasts
   * a reload to every connected browser; `close()` shuts the socket down on
   * shutdown. Absent → no live reload (a save needs a manual refresh, the prior
   * behaviour). The bin owns the socket; the core decides WHEN to inject and notify.
   */
  liveReload?: LiveReload;

  /** Build a static-deploy uploader rooted at `distDir` (the bin passes `nodeUploader`). */
  uploader: (distDir: string) => ShipDeps;

  /**
   * Build a versioned release store for a {@link ReleaseTarget}. Backs
   * `deploy --release` and `rollback`: immutable `releases/<version>/` trees
   * behind an atomically-flipped `current` pointer. The bin maps a `local`
   * target to `nodeReleaseStore` and a `remote` one to `remoteReleaseStore`
   * (S3/R2), reading the remote credentials from the environment so the core
   * never handles a secret.
   */
  releaseStore: (target: ReleaseTarget) => ReleaseStore;

  /** The clock release version stamps derive from (the bin passes `Date.now`). */
  now: () => number;

  /**
   * The Cloudflare deploy driver `lesto deploy --cloudflare` pushes the Worker
   * through (the bin wires the `wrangler` CLI; tests inject a fake). See
   * {@link CloudflareDeployer}.
   */
  cloudflare: CloudflareDeployer;

  /**
   * Probe a deployed URL's health, resolving `true` iff it answers OK. Runs
   * after a `--cloudflare` deploy and gates the result: a failing probe rolls the
   * Worker back. The bin wires a timed `fetch` (a thrown/timed-out request is
   * `false`); tests inject a fake.
   */
  checkHealth: (url: string) => Promise<boolean>;

  /**
   * Register a graceful-shutdown hook for the long-running `serve`/`dev`
   * commands: the bin wires SIGTERM/SIGINT to drain the server and exit, so a
   * deploy's rolling restart lets in-flight requests finish instead of severing
   * them. Absent in tests and for one-shot commands, which never linger.
   */
  installShutdown?: (drain: () => Promise<void>) => void;

  /**
   * The environment the OTLP tracer reads its two-var setup from
   * (`LESTO_OTLP_URL` + service-name/headers — see {@link TracesEnv}) AND the
   * operator-tunable DoS limits read from (`LESTO_MAX_BODY_BYTES` etc. — see
   * {@link ServeLimitsEnv}). Defaults to `process.env`, so the bin needs no extra
   * wiring; a test injects a literal. `LESTO_OTLP_URL` absent means tracing is off
   * (no tracer, zero overhead); every limit var absent leaves `serve`'s secure
   * defaults in place — the safe defaults.
   */
  env?: TracesEnv & ServeLimitsEnv;

  /** Where a line of output goes (the bin passes `console.log`). */
  out: (line: string) => void;
}

/** The usage text printed for `help`, an empty command, or an unknown command. */
const USAGE = [
  "lesto — the Lesto command-line tool",
  "",
  "Usage: lesto <command> [options]",
  "",
  "Commands:",
  "  g, generate       Scaffold a resource: generate <model|migration|island> <Name> [field:type …]",
  "                    e.g. `lesto g model Post title:string published:boolean` (--dry-run to preview)",
  "  routes            List the application's routes",
  "  routes:gen        Regenerate the edge route manifest (routes.gen.ts) from app/routes/",
  "  migrate           Run pending migrations and print the applied versions",
  "  serve             Boot the app over HTTP (--port, default 3000)",
  "  dev               Run every site live on one origin for local development (--port)",
  "  build             Prerender static sites to disk (--target <name>, --out <dir>, default out)",
  "  deploy            Build and ship the app. --cloudflare is the one-command edge deploy:",
  "                    `lesto deploy --cloudflare` pushes the Worker + its Static Assets via wrangler",
  "                    (health-gated with --health-url <url>). Otherwise it ships static sites and prints",
  "                    the routing plan (--target, --out, --dist; --release for a versioned,",
  "                    atomically-flipped release, --version <v> to name it; publish a release to S3/R2",
  "                    with --bucket <name> --endpoint <url> [--region auto] [--pointer <key>] (implies",
  "                    --release; credentials from the environment), else --dist)",
  "  rollback          Flip the live pointer to a published release: rollback --to <version>",
  "                    (--dist for local, or --bucket/--endpoint for a remote S3/R2 store)",
  "  content:build     Compile markdown content into the content store (--prune drops stale rows)",
  "  content:new       Scaffold a new content entry: content:new <collection> <title>",
  "  content:delete    Delete a content entry: content:delete <collection> <slug>",
  "  help              Show this help",
].join("\n");

/** Print every route the app declares, one per line as `method\tpattern`. */
async function runRoutes(deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  // The code-first `lesto()` app exposes its routes as `{ method, pattern }` — the
  // only route surface now that the legacy `Router` is gone (ADR 0004 Phase 7.6).
  for (const route of config.app.routes()) {
    deps.out(`${route.method}\t${route.pattern}`);
  }

  return 0;
}

/** Boot the app (which runs migrations) and print the versions that applied. */
async function runMigrate(deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  const app = await createApp(config);

  for (const version of app.migrationsApplied) {
    deps.out(`applied ${version}`);
  }

  return 0;
}

/**
 * A readiness probe over the app's database: a trivial query that proves the
 * connection actually answers.
 *
 * `/readyz` defaults to always-ready, which lies — an orchestrator would route
 * traffic to a node whose database is down or mid-failover. This makes the probe
 * honest: a thrown error (connection gone, pool exhausted) resolves to `false`,
 * so the runtime answers `/readyz` with 503 and the node is taken out of
 * rotation until its database recovers.
 */
function databaseReady(db: KernelDatabase): () => Promise<boolean> {
  return async () => {
    try {
      await db.prepare("SELECT 1").get();

      return true;
    } catch {
      return false;
    }
  };
}

/**
 * The in-flight request span, as the tracer's `currentSpan` seam.
 *
 * `@lesto/web`'s `currentRequestSpan` (tested there) reads the span the runtime
 * published on the request context; a tracer seam (a db query, an inline job)
 * parents its child span on it. `RequestContextSpan` is structurally the tracing
 * `Span` — both carry `data.{traceId,spanId}` and the fluent setters — so the
 * cast on the function reference is true: it narrows the read-only context shape
 * to the tracer's seam type without introducing any new logic to cover.
 */
const requestSpan = currentRequestSpan as CurrentSpan;

/**
 * The tracing wired onto a long-lived `serve`/`dev` server, or `undefined` when
 * tracing is off (`LESTO_OTLP_URL` unset).
 *
 * `serveOptions` is the slice handed to `deps.serve` — the request tracer (so
 * every request mints a span), the `traceparent` parser (so a cross-service
 * request joins one trace), and the `onDrain` flush (so the last batch reaches
 * the collector on a rolling restart). `stopInterval` halts the steady flush
 * cadence; the caller stops it on shutdown, after the final drain flush has run.
 */
interface ServeTracing {
  readonly serveOptions: {
    readonly tracer: Traces["requestTracer"];
    readonly parseTraceparent: typeof parseTraceparent;
    readonly onDrain: () => Promise<void>;
  };

  /**
   * The per-domain seam hooks the app threads into its own batteries — the one we
   * use here is `seams.onQuery`, handed to `loadApp(seams)` so a project that
   * default-exports a config factory wires `createDb(handle, { onQuery })` and a
   * query run during a request becomes a `db.query` child span of the request
   * span. Absent (tracing off) the seams never reach the app, so it stays untraced.
   */
  readonly seams: TraceSeams;

  readonly stopInterval: () => void;
}

/**
 * Construct the OTLP tracer from the environment and the flush lifecycle a
 * long-lived server runs.
 *
 * `tracesFromEnv` reads the two-var setup (`LESTO_OTLP_URL` is the on switch) and
 * builds the `Tracer` + `OtlpHttpExporter`; absent a URL it returns `undefined`
 * and so do we — the server runs untraced, zero overhead. With tracing on we
 * start the steady flush interval and hand back the serve-options slice
 * (request tracer + `traceparent` parser + an `onDrain` final flush). The request
 * span seam reads `context.span`, so a db query or inline job fired during a
 * request parents on the request span.
 *
 * THE CONTRACT (mirrored by `@lesto/cloudflare`, edge-deploy #3): the env vars
 * are `LESTO_OTLP_URL` / `LESTO_OTLP_SERVICE` / `LESTO_OTLP_HEADERS`; the flush API
 * is `traces.flush()` (an edge worker calls it from `ctx.waitUntil`); here the
 * node tier flushes on an interval AND on drain.
 */
function buildServeTracing(deps: CliDeps): ServeTracing | undefined {
  const traces = tracesFromEnv(deps.env ?? {}, { currentSpan: requestSpan });

  if (traces === undefined) return undefined;

  const stopInterval = traces.startInterval(TRACE_FLUSH_INTERVAL_MS);

  return {
    serveOptions: {
      tracer: traces.requestTracer,
      parseTraceparent,
      // Drain flush: ship whatever is still buffered after in-flight requests
      // finish, so a rolling restart does not drop the final spans.
      onDrain: () => traces.flush(),
    },
    // The seam hooks the app threads into its batteries: `onQuery` rides into
    // `loadApp(seams)` so the served path emits db child-spans, exactly as the
    // request tracer above makes the parent `http.request` span.
    seams: traces.seams,
    stopInterval,
  };
}

/**
 * The operator-tunable DoS limits, read from the environment — the same
 * env-driven precedent {@link TracesEnv} sets. Each is a positive integer (bytes
 * or milliseconds); `serve` already enforces SECURE DEFAULTS for every one
 * (`packages/runtime/src/server.ts`), so these only exist to RETUNE them at deploy
 * time without reaching for the programmatic API.
 *
 *   - `LESTO_MAX_BODY_BYTES`      — largest request body read off a socket (413 above
 *                                  it). Default 1 MiB.
 *   - `LESTO_MAX_JSON_BODY_BYTES` — tighter cap for `application/json` bodies (caps
 *                                  `JSON.parse` blast radius). Default 1 MiB.
 *   - `LESTO_HANDLER_TIMEOUT_MS`  — longest a single handler may run (503 on overrun).
 *                                  Default 30s.
 *   - `LESTO_REQUEST_TIMEOUT_MS`  — node:http per-request socket deadline (slow-loris
 *                                  defense). Default 30s.
 *   - `LESTO_HEADERS_TIMEOUT_MS`  — longest a client may take to send the full header
 *                                  block (slow-header / slow-loris defense). Default 15s.
 *   - `LESTO_KEEP_ALIVE_TIMEOUT_MS` — how long an idle keep-alive socket is held before
 *                                  close (idle-socket exhaustion defense). Default 5s.
 *   - `LESTO_MAX_HEADER_BYTES`    — largest header block accepted (oversized-header
 *                                  defense). Default 16 KiB.
 *   - `LESTO_DRAIN_TIMEOUT_MS`    — how long a graceful shutdown waits for in-flight
 *                                  requests before forcing sockets closed. Default 10s.
 *   - `LESTO_MAX_CONNECTIONS`     — live TCP connections the node holds before refusing
 *                                  new ones (connection-flood backstop). Default 10000.
 *   - `LESTO_MAX_IN_FLIGHT_REQUESTS` — requests in flight before a graceful 503 shed
 *                                  (request-flood backstop). Default 1000.
 *
 * An UNSET, non-numeric, or ≤0 value is ignored — the var falls through to
 * `serve`'s secure default rather than weakening it (a `0` would disable the
 * limit). So the safe baseline always holds unless an operator deliberately
 * raises it.
 */
export interface ServeLimitsEnv {
  readonly LESTO_MAX_BODY_BYTES?: string | undefined;
  readonly LESTO_MAX_JSON_BODY_BYTES?: string | undefined;
  readonly LESTO_HANDLER_TIMEOUT_MS?: string | undefined;
  readonly LESTO_REQUEST_TIMEOUT_MS?: string | undefined;
  readonly LESTO_HEADERS_TIMEOUT_MS?: string | undefined;
  readonly LESTO_KEEP_ALIVE_TIMEOUT_MS?: string | undefined;
  readonly LESTO_MAX_HEADER_BYTES?: string | undefined;
  readonly LESTO_DRAIN_TIMEOUT_MS?: string | undefined;
  readonly LESTO_MAX_CONNECTIONS?: string | undefined;
  readonly LESTO_MAX_IN_FLIGHT_REQUESTS?: string | undefined;
}

/**
 * Parse one env limit into a positive integer, or `undefined` to fall through to
 * `serve`'s secure default.
 *
 * Unset (`undefined`), non-numeric (`NaN`), and any value `<= 0` all yield
 * `undefined` — we NEVER hand `serve` a zero or negative limit, because that would
 * weaken (or disable) a defense the default already set safely. Only a clean
 * positive integer overrides the default. Exported so every branch (unset,
 * non-numeric, zero/negative, valid) is unit-testable.
 */
export function parseServeLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;

  const value = Number(raw);

  // `Number("")` is 0 and `Number("12px")` is NaN — both rejected by the guards:
  // a non-finite or non-positive value never overrides the secure default.
  if (!Number.isFinite(value) || value <= 0) return undefined;

  return Math.trunc(value);
}

/**
 * The DoS-limit slice handed to `deps.serve(app, { ...this })`, built from the
 * environment. Only the keys an operator set to a valid positive value are
 * present, so `serve`'s secure default applies to every omitted one
 * (`exactOptionalPropertyTypes` forbids assigning `undefined`, so each present
 * key is conditionally spread in).
 *
 * The slice is intentionally additive: spread it alongside the tracing options on
 * the serve call, and it tunes only what the operator opted into.
 */
function serveLimitsFromEnv(env: ServeLimitsEnv): {
  maxBodyBytes?: number;
  maxJsonBodyBytes?: number;
  handlerTimeoutMs?: number;
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  maxHeaderBytes?: number;
  drainTimeoutMs?: number;
  maxConnections?: number;
  maxInFlightRequests?: number;
} {
  const maxBodyBytes = parseServeLimit(env.LESTO_MAX_BODY_BYTES);
  const maxJsonBodyBytes = parseServeLimit(env.LESTO_MAX_JSON_BODY_BYTES);
  const handlerTimeoutMs = parseServeLimit(env.LESTO_HANDLER_TIMEOUT_MS);
  const requestTimeoutMs = parseServeLimit(env.LESTO_REQUEST_TIMEOUT_MS);
  const headersTimeoutMs = parseServeLimit(env.LESTO_HEADERS_TIMEOUT_MS);
  const keepAliveTimeoutMs = parseServeLimit(env.LESTO_KEEP_ALIVE_TIMEOUT_MS);
  const maxHeaderBytes = parseServeLimit(env.LESTO_MAX_HEADER_BYTES);
  const drainTimeoutMs = parseServeLimit(env.LESTO_DRAIN_TIMEOUT_MS);
  const maxConnections = parseServeLimit(env.LESTO_MAX_CONNECTIONS);
  const maxInFlightRequests = parseServeLimit(env.LESTO_MAX_IN_FLIGHT_REQUESTS);

  return {
    ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
    ...(maxJsonBodyBytes !== undefined ? { maxJsonBodyBytes } : {}),
    ...(handlerTimeoutMs !== undefined ? { handlerTimeoutMs } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(headersTimeoutMs !== undefined ? { headersTimeoutMs } : {}),
    ...(keepAliveTimeoutMs !== undefined ? { keepAliveTimeoutMs } : {}),
    ...(maxHeaderBytes !== undefined ? { maxHeaderBytes } : {}),
    ...(drainTimeoutMs !== undefined ? { drainTimeoutMs } : {}),
    ...(maxConnections !== undefined ? { maxConnections } : {}),
    ...(maxInFlightRequests !== undefined ? { maxInFlightRequests } : {}),
  };
}

/**
 * Boot the app and stand a server in front of it, printing the listening URL.
 *
 * Resolves once the server is listening — the core does not block forever; the
 * bin is what keeps the process alive after this returns. `/readyz` is wired to
 * a real database ping so it reports the node's true readiness, not a constant.
 *
 * When `LESTO_OTLP_URL` is set, an OTLP tracer is constructed and wired: every
 * request mints a span, an inbound `traceparent` joins one trace, spans flush on
 * an interval, and a final flush runs on graceful drain.
 */
async function runServe(args: readonly string[], deps: CliDeps): Promise<number> {
  // Construct the OTLP tracer from the env (off unless `LESTO_OTLP_URL` is set)
  // BEFORE loading the app, so its `seams` can be threaded into `loadApp`: a
  // project whose `lesto.app.ts` default-exports a config factory wires
  // `db.onQuery` from `seams.onQuery`, and a query run during a request becomes a
  // `db.query` CHILD span of the request span — the served path's deep
  // request→query tree, not just the integration harness's. When on, its
  // serve-options slice (request tracer + `traceparent` parser + drain flush)
  // rides into `serve` and the steady flush interval is running.
  const tracing = buildServeTracing(deps);

  // Hand the trace seams to the app loader when tracing is on; absent, `loadApp`
  // is called with no seams (a plain-config project is unchanged either way).
  const config = await deps.loadApp(tracing?.seams);

  const app = await createApp(config);

  const { port } = parsePort(args, DEFAULT_PORT);

  const server = await deps.serve(app, {
    port,
    health: { isReady: databaseReady(config.db) },
    // The operator-tunable DoS limits (`LESTO_MAX_BODY_BYTES` etc.): present only
    // for the vars an operator set to a valid positive value, so `serve`'s secure
    // default holds for every omitted one (and when no var is set at all).
    ...serveLimitsFromEnv(deps.env ?? {}),
    ...(tracing === undefined ? {} : tracing.serveOptions),
  });

  // On graceful shutdown: drain the server (its `onDrain` flushes the final
  // batch), THEN stop the flush interval — order matters, so the last flush is
  // not cut short by a stopped cadence.
  deps.installShutdown?.(async () => {
    await server.close();

    tracing?.stopInterval();
  });

  deps.out(`listening on http://127.0.0.1:${server.port}`);

  return 0;
}

/** "entry" or "entries" — the count noun the build output reads with. */
function entryNoun(count: number): string {
  return count === 1 ? "entry" : "entries";
}

/**
 * Compile markdown content into the database.
 *
 * Booting the app applies its migrations — `contentEntriesMigration` among them
 * — so the table is there before the pipeline's entries are upserted onto it.
 * Content now lives on the same SQL substrate as everything else.
 */
async function runContentBuild(args: readonly string[], deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  await createApp(config);

  const entries = await deps.buildContent();

  const { persisted } = await deps.persistEntries(config.db, entries);

  deps.out(`built ${persisted} ${entryNoun(persisted)} into the content store`);

  // `--prune` makes the store mirror the build: rows for source that no longer
  // exists are dropped. Opt-in, because a misconfigured build would otherwise
  // wipe content.
  if (args.includes("--prune")) {
    const { deleted } = await deps.pruneEntries(config.db, entries);

    deps.out(`pruned ${deleted} stale ${entryNoun(deleted)}`);
  }

  return 0;
}

/** Scaffold a new entry into a collection from its `<collection> <title>`. */
async function runContentNew(args: readonly string[], deps: CliDeps): Promise<number> {
  const [collection, ...titleWords] = args;
  const title = titleWords.join(" ");

  if (!collection || !title) {
    throw new CliError(
      "CLI_CONTENT_MISSING_ARGS",
      "content:new needs a collection and a title: lesto content:new <collection> <title>",
      { collection, title },
    );
  }

  await deps.createEntry(collection, title);

  deps.out(`created ${collection} entry: ${title}`);

  return 0;
}

/** Delete a content entry from the store by its `<collection> <slug>`. */
async function runContentDelete(args: readonly string[], deps: CliDeps): Promise<number> {
  const [collection, slug] = args;

  if (!collection || !slug) {
    throw new CliError(
      "CLI_CONTENT_MISSING_ARGS",
      "content:delete needs a collection and a slug: lesto content:delete <collection> <slug>",
      { collection, slug },
    );
  }

  const config = await deps.loadApp();

  await createApp(config);

  const { deleted } = await deps.deleteEntry(config.db, collection, slug);

  deps.out(
    deleted === 0 ? `no ${collection} entry: ${slug}` : `deleted ${collection} entry: ${slug}`,
  );

  return 0;
}

/** The default output directory for `build` when no `--out` flag is given. */
const DEFAULT_OUT_DIR = "out";

/** "page" or "pages" — the count noun the build output reads with. */
function pageNoun(count: number): string {
  return count === 1 ? "page" : "pages";
}

/**
 * Narrow the site set to a single `--target`, or refuse an unknown name.
 *
 * No `--target` builds every site. A `--target` that names a declared site
 * builds just that one; a name that matches nothing is a mistake the caller must
 * fix — surfaced by a stable code, not a confusing empty build.
 */
function selectTarget(sites: readonly Site[], target: string | undefined): readonly Site[] {
  if (target === undefined) return sites;

  const chosen = sites.filter((site) => site.name === target);

  if (chosen.length === 0) {
    throw new CliError("CLI_UNKNOWN_TARGET", `No site named "${target}".`, {
      target,
      known: sites.map((site) => site.name),
    });
  }

  return chosen;
}

/**
 * Build the island client bundle into `outDir` when the project has an
 * `app/islands/` directory, wrapping any bundler failure in a coded CLI error so
 * the command fails loudly rather than shipping a static site with no runtime.
 * A project without the directory is a no-op (an island-less app is unchanged).
 *
 * The probe (`hasIslandsDir`) and the builder (`buildClientAssets`) are seams the
 * bin wires to the real filesystem + `@lesto/assets`; absent, the CLI never builds
 * client assets.
 */
async function buildClientIfPresent(
  deps: CliDeps,
  outDir: string,
  mode: "dev" | "production",
  dialect: UiDialect,
): Promise<void> {
  if (deps.hasIslandsDir === undefined || deps.buildClientAssets === undefined) return;

  if (!(await deps.hasIslandsDir())) return;

  try {
    await deps.buildClientAssets({ outDir, mode, dialect });
  } catch (cause) {
    throw new CliError(
      "CLI_CLIENT_BUILD_FAILED",
      "the island client build failed — see the cause for the bundler error",
      { outDir, mode, dialect, cause },
    );
  }
}

/**
 * The UI dialect a config selects — the matched pair's single source (ADR 0008).
 *
 * Read from `config.ui.dialect`; absent defaults to `"react"`. The CLI hands this
 * to the client build, while `createApp` wires the server renderer from the same
 * key — so the client alias and the server renderer are always the same dialect.
 */
function dialectOf(config: LestoAppConfig): UiDialect {
  return config.ui !== undefined ? config.ui.dialect : "react";
}

/** The project convention for the Tailwind CSS entry when `ui.css` is unset (ADR 0037). */
const DEFAULT_CSS_ENTRY = "app/styles/app.css";

/**
 * The Tailwind CSS entry a config selects (ADR 0037) — `config.ui.css`, or the
 * `app/styles/app.css` convention when unset. The path is project-relative; the
 * bin resolves it against the project root. Whether the resolved file actually
 * exists (and so whether the CSS build runs at all) is the `cssEntryExists` seam's
 * call — this only names the path to probe.
 */
function cssEntryOf(config: LestoAppConfig): string {
  return config.ui?.css ?? DEFAULT_CSS_ENTRY;
}

/**
 * Build the Tailwind stylesheet into `outDir` when the project's resolved CSS entry
 * exists, wrapping any compile failure in a coded CLI error so the command fails
 * loudly rather than shipping a page with no styles. A project with no CSS entry is
 * a no-op (Tailwind is opt-in) — the matched sibling of {@link buildClientIfPresent}.
 *
 * The probe (`cssEntryExists`) and the builder (`buildAppStyles`) are seams the bin
 * wires to the real filesystem + a lazy `@lesto/styles` import; absent, the CLI never
 * builds CSS.
 */
async function buildStylesIfPresent(
  deps: CliDeps,
  config: LestoAppConfig,
  outDir: string,
  mode: "dev" | "production",
): Promise<void> {
  if (deps.cssEntryExists === undefined || deps.buildAppStyles === undefined) return;

  const entry = cssEntryOf(config);

  if (!(await deps.cssEntryExists(entry))) return;

  try {
    await deps.buildAppStyles({ entry, outDir, mode });
  } catch (cause) {
    throw new CliError(
      "CLI_STYLES_BUILD_FAILED",
      "the Tailwind CSS build failed — see the cause for the compiler error",
      { outDir, mode, entry, cause },
    );
  }
}

/**
 * The human message for a watch-triggered rebuild failure. A `buildClientIfPresent`
 * failure is a coded `CliError` carrying the bundler's own error as
 * `details.cause` — that cause's message is what an author needs. Falls back to
 * the error's own string form when no useful cause is present.
 */
function rebuildErrorMessage(error: unknown): string {
  const cause = error instanceof CliError ? error.details["cause"] : undefined;

  if (cause instanceof Error) return cause.message;

  return String(error);
}

/**
 * The effective error behind a dev failure: the bundler/loader cause when the
 * failure is a coded {@link CliError} wrapping an `Error` (the `details.cause` whose
 * message {@link rebuildErrorMessage} shows), else the error itself. Lets the overlay
 * read a clean `.message`/`.stack` off one value instead of re-walking the wrap.
 */
function unwrapCause(error: unknown): unknown {
  const cause = error instanceof CliError ? error.details["cause"] : undefined;

  return cause instanceof Error ? cause : error;
}

/**
 * Build the {@link DevError} broadcast for a caught dev failure — the author-facing
 * message plus the cause's stack when one exists. The overlay unwraps a raw `Error`'s
 * bare `.message` (never the `Error: ` prefix `String(error)` adds, so an island error
 * reads the same as a route one); a non-`Error` throw (a string) has no frames, and
 * omitting an absent `stack` keeps the payload exact under `exactOptionalPropertyTypes`.
 */
function devError(source: DevErrorSource, error: unknown): DevError {
  const cause = unwrapCause(error);

  const message = cause instanceof Error ? cause.message : String(cause);
  const stack = cause instanceof Error ? cause.stack : undefined;

  return { source, message, ...(stack === undefined ? {} : { stack }) };
}

/**
 * Prerender the project's static sites to disk.
 *
 * Boots the app, loads its declared sites, and hands the app's own `handle` to
 * `buildStaticSites` — which fails the build on any page that did not render
 * before writing a single file. `--target <name>` builds one site; `--out <dir>`
 * picks the output root (default `out`). One line per built site reports its
 * page count.
 *
 * When the project has an `app/islands/` directory, a production client build
 * runs first so `/client.js` + its chunks land in the artifact alongside the
 * prerendered HTML (ADR 0011 Seam 3).
 */
async function runBuild(args: readonly string[], deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  const app = await createApp(config);

  const sites = await deps.loadSites();

  const target = parseStringFlag(args, "target");
  const outDir = parseStringFlag(args, "out") ?? DEFAULT_OUT_DIR;

  const selected = selectTarget(sites, target);

  await buildClientIfPresent(deps, outDir, "production", dialectOf(config));

  await buildStylesIfPresent(deps, config, outDir, "production");

  const manifest = await buildStaticSites(selected, app.handle, deps.sink(outDir));

  for (const site of manifest) {
    deps.out(`built ${site.site}: ${site.pages.length} ${pageNoun(site.pages.length)}`);
  }

  return 0;
}

/**
 * Regenerate the edge route manifest (`routes.gen.ts`) from `app/routes/`.
 *
 * The standalone `lesto routes:gen` command (Workstream 3): it folds what was a
 * per-app `regenerate-routes.ts` script into the CLI, so refreshing the edge's
 * static-import map is one first-class command. `deps.regenerateRoutes` does the
 * scan → `generateRouteManifest` → write (the bin wires the real fs); a project
 * with no `app/routes/` is a no-op the command says out loud, not an error.
 *
 * This is the EDGE path — the manifest a Worker bundles — NOT the Node dev re-scan;
 * the two are deliberately separate (see {@link CliDeps.regenerateRoutes}).
 */
async function runRoutesGen(deps: CliDeps): Promise<number> {
  if (deps.regenerateRoutes === undefined) {
    // No seam wired (a test that did not opt in, or a build that disabled it): say
    // so rather than silently exit, so the operator knows nothing was written.
    deps.out("routes:gen is not available in this environment");

    return 0;
  }

  const result = await deps.regenerateRoutes();

  if (result === undefined) {
    deps.out("no app/routes/ directory — nothing to generate");

    return 0;
  }

  deps.out(`generated ${result.path} (${result.count} route ${fileNoun(result.count)})`);

  return 0;
}

/** "file" or "files" — the count noun the routes:gen output reads with. */
function fileNoun(count: number): string {
  return count === 1 ? "file" : "files";
}

/**
 * Wrap a dev handle so every `text/html` response carries the live-reload client
 * script — the seam that makes a saved page reload the open browser.
 *
 * The script is appended as a trailing `<script>` after the document; a browser
 * executes a trailing script fine, so this needs no HTML parsing and never touches
 * the page's own streaming (it adds one final chunk). A non-HTML response (JSON, an
 * asset, a redirect) passes through untouched. The body may be a string (buffered
 * Preact / a plain response) or a `ReadableStream` (React streaming) — each is
 * handled without buffering the stream.
 */
function withLiveReload(
  handle: (method: string, path: string, options?: HandleOptions) => Promise<LestoResponse>,
  script: string,
): (method: string, path: string, options?: HandleOptions) => Promise<LestoResponse> {
  const tag = `<script>${script}</script>`;

  return async (method, path, options) => {
    const response = await handle(method, path, options);

    if (!isHtmlResponse(response)) return response;

    return { ...response, body: appendToBody(response.body, tag) };
  };
}

/** True iff a response's `content-type` is HTML (only those carry the reload script). */
function isHtmlResponse(response: LestoResponse): boolean {
  const contentType = response.headers["content-type"];
  const value = Array.isArray(contentType) ? contentType[0] : contentType;

  return value !== undefined && value.includes("text/html");
}

/**
 * Append `tag` to a response body, whether it is a string or a stream.
 *
 * A string body is concatenated directly. A stream body is wrapped in a transform
 * that passes every chunk through and emits `tag` as the final chunk before close —
 * so the live-reload script lands at the very end of the streamed document without
 * buffering it. `Uint8Array` bodies are not HTML (assets), so this is only ever
 * reached for the string and stream arms a page render produces.
 */
function appendToBody(body: LestoResponse["body"], tag: string): LestoResponse["body"] {
  if (typeof body === "string") return body + tag;

  // A stream: pipe it through, then enqueue the tag once before closing. The cast
  // narrows the declared `string` body of the dispatch contract to the stream a
  // page render actually produced (LestoResponse defaults its body to `string`, but
  // a page streams — see types.ts; the transport widens, and here we transform it).
  const stream = body as unknown as ReadableStream<Uint8Array>;
  const encoder = new TextEncoder();

  const transformed = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush(controller) {
        controller.enqueue(encoder.encode(tag));
      },
    }),
  );

  return transformed as unknown as LestoResponse["body"];
}

/**
 * Run every site live on one origin, for local development.
 *
 * Unlike `serve` (a single production app) and `build` (a one-shot prerender),
 * `dev` renders *every* zone live through the app's own `handle` — so a static
 * zone needs no prebuild and an edit shows on the next refresh. With a
 * `readAsset` seam it also serves the client bundle (`/client.js`) so islands
 * hydrate. One origin, so the same-origin session just works.
 *
 * When the project has an `app/islands/` directory, an unminified client build
 * runs on boot (into the dev asset dir `readAsset` serves) and a debounced
 * watcher rebuilds it on change (ADR 0011 Seam 3), so an island edit shows on the
 * next refresh without restarting the dev server.
 *
 * Workstream 3 adds the page/route loop: with `watchRoutes` the dev server watches
 * `app/routes/` and, on a change, re-loads the app (so a NEW route appears WITHOUT
 * a restart — `applyDiscoveredRoutes` no longer runs only once), refreshes the edge
 * manifest, and — with `liveReload` — reloads the open browser over a WebSocket. The
 * live server fronts a FORWARDING handle, so swapping in the re-loaded app's handle
 * takes effect on the next request with no socket churn.
 */
async function runDev(args: readonly string[], deps: CliDeps): Promise<number> {
  // Tracing is wired on `dev` exactly as on `serve` (off unless `LESTO_OTLP_URL`
  // is set), so a developer sees the same spans locally that production emits.
  // Built BEFORE the app so its `seams` thread into `loadApp` — a project whose
  // `lesto.app.ts` default-exports a config factory wires `db.onQuery` and a
  // query run during a dev request becomes a `db.query` child span.
  const tracing = buildServeTracing(deps);

  const config = await deps.loadApp(tracing?.seams);

  const app = await createApp(config);

  const sites = await deps.loadSites();

  // The matched pair's client half (ADR 0008): the same `ui.dialect` key
  // `createApp` just wired the server renderer from also picks the client alias,
  // so dev's bundle and its server render speak one dialect.
  const dialect = dialectOf(config);

  // Build the island client on boot, then watch for changes. The dev outDir is
  // the same root the bin's `readAsset` serves from (DEFAULT_OUT_DIR).
  await buildClientIfPresent(deps, DEFAULT_OUT_DIR, "dev", dialect);

  // Compile the Tailwind stylesheet on boot too, so `/styles.css` is served from
  // the first request (ADR 0037); the dev watch below rebuilds + hot-swaps it.
  await buildStylesIfPresent(deps, config, DEFAULT_OUT_DIR, "dev");

  // One dev error overlay is up at a time; track it so a clean island rebuild
  // reloads ONLY to dismiss a shown overlay (recovering from an island error) and
  // otherwise leaves the page — and its island state — exactly as before the overlay
  // existed. A route change reloads regardless (a new route needs a fresh document).
  let overlayUp = false;

  const reloadBrowser = (): void => {
    overlayUp = false;
    deps.liveReload?.notify();
  };

  const showOverlay = (error: DevError): void => {
    overlayUp = true;
    deps.liveReload?.notifyError(error);
  };

  // A change rebuilds the bundle; a rebuild failure during dev is reported AND painted
  // as an overlay, not fatal — the dev server stays up so the next save can fix it.
  // The coded `CliError`'s `details.cause` is the bundler's own error, the message
  // worth showing.
  if (deps.hasIslandsDir !== undefined && (await deps.hasIslandsDir())) {
    deps.watchIslands?.(() => {
      void buildClientIfPresent(deps, DEFAULT_OUT_DIR, "dev", dialect).then(
        // A clean rebuild reloads only to clear a shown overlay (the new bundle then
        // loads too); with no overlay up it leaves the page alone — until HMR lands
        // (the separate live-reload task), an island edit still shows on next refresh.
        () => (overlayUp ? reloadBrowser() : undefined),
        (error: unknown) => {
          deps.out(`client rebuild failed: ${rebuildErrorMessage(error)}`);
          showOverlay(devError("client-rebuild", error));
        },
      );
    });
  }

  // The CSS dev loop (ADR 0037 TW4): Tailwind classes live across ALL of `app/`
  // (routes, components, islands), so this watches the broader source set than the
  // island watcher above. A clean rebuild HOT-SWAPS the stylesheet `<link>` (no
  // reload, so island state survives a style edit) — unless an overlay is up, when it
  // reloads to clear it, exactly as the island rebuild does. A compile failure paints
  // the overlay (cleared by the next successful build).
  if (deps.cssEntryExists !== undefined && (await deps.cssEntryExists(cssEntryOf(config)))) {
    deps.watchStyleSources?.(() => {
      void buildStylesIfPresent(deps, config, DEFAULT_OUT_DIR, "dev").then(
        () => (overlayUp ? reloadBrowser() : deps.liveReload?.notifyStyleUpdate()),
        (error: unknown) => {
          deps.out(`css rebuild failed: ${rebuildErrorMessage(error)}`);
          showOverlay(devError("style-rebuild", error));
        },
      );
    });
  }

  // The live server fronts a FORWARDING handle, not the app's handle directly: a
  // watched route change re-loads the app and points `activeHandle` at the new one,
  // so a route ADD shows on the next request WITHOUT a server restart (the prior
  // limitation: `applyDiscoveredRoutes` ran once in `loadApp`). The forwarder reads
  // `activeHandle` per request, so the swap is atomic and needs no socket churn.
  let activeHandle = app.handle;

  const forward = (method: string, path: string, options?: HandleOptions): Promise<LestoResponse> =>
    activeHandle(method, path, options);

  // With live reload on, every dev HTML response carries the reload client script,
  // so a saved file reloads the open browser over the WebSocket the bin runs.
  const devHandle =
    deps.liveReload === undefined ? forward : withLiveReload(forward, deps.liveReload.script);

  // Tolerate an app with no declared sites (a missing `lesto.sites.ts`, which the
  // bin's loader resolves to `[]`): dispatch every path straight to the app, so a
  // freshly scaffolded app boots and serves before its author writes a sites file.
  // A declared site set routes as before.
  const dispatch = dispatchSitesDev({
    sites: sites.length === 0 ? [APP_ONLY_SITE] : sites,
    handle: devHandle,
    ...(deps.readAsset === undefined ? {} : { readAsset: deps.readAsset }),
  });

  // Watch `app/routes/` (Workstream 3). On a debounced change: refresh the EDGE
  // manifest (`routes.gen.ts`), re-load the app so a NEW route is live without a
  // restart (the NODE re-scan — distinct from the edge manifest above), and reload
  // the browser. A failure in any step is reported, not fatal — the dev server
  // stays up so the next save can fix it.
  const onRouteChange = async (): Promise<void> => {
    const { handle, error } = await refreshRoutes(deps);

    if (handle !== undefined) activeHandle = handle;

    // A clean refresh reloads the browser (clearing any overlay); a failure pushes
    // the overlay INSTEAD of reloading — a reload would just re-paint the stale app
    // and hide that the save did not take.
    if (error === undefined) reloadBrowser();
    else showOverlay(error);
  };

  const stopRoutes = deps.watchRoutes?.(() => void onRouteChange());

  const { port } = parsePort(args, DEFAULT_PORT);

  // Wrap the dev dispatcher as the app the server fronts; migrations already ran.
  const server = await deps.serve(
    { handle: dispatch, migrationsApplied: app.migrationsApplied },
    {
      port,
      // The same operator-tunable DoS limits `serve` honors (`LESTO_MAX_BODY_BYTES`
      // etc.): a developer testing a large-upload or slow-handler route locally
      // tunes them here too, and every unset var falls through to the secure default.
      ...serveLimitsFromEnv(deps.env ?? {}),
      ...(tracing === undefined ? {} : tracing.serveOptions),
    },
  );

  deps.installShutdown?.(async () => {
    await server.close();

    stopRoutes?.();
    deps.liveReload?.close();
    tracing?.stopInterval();
  });

  deps.out(`dev server on http://127.0.0.1:${server.port}`);

  return 0;
}

/** A bound app dispatch handle — what the dev server's forwarder points at. */
type AppHandle = (method: string, path: string, options?: HandleOptions) => Promise<LestoResponse>;

/**
 * Process one watched route change: refresh the edge manifest and re-load the app,
 * returning the re-loaded app's `handle` (or `undefined` when nothing re-loaded) plus
 * the `error` to surface as a dev overlay (or `undefined` when every step succeeded).
 *
 * The two halves are kept SEPARATE per the plan: `regenerateRoutes` refreshes the
 * EDGE manifest (`routes.gen.ts`, the Worker's static-import map), while `reloadApp`
 * is the NODE re-scan (a fresh config whose file routes were re-imported) that, once
 * `createApp`'d, lets a new route serve without a restart. Either seam may be absent
 * (a project with no `app/routes/`, or a test that opted into only one). Both failures
 * are reported on stderr so the dev server survives a transient error mid-edit; only
 * the `app-reload` one returns a {@link DevError} for the overlay — a manifest regen
 * failure leaves the running dev page working (it is only the edge import map), so it
 * never escalates to a blocking overlay.
 */
async function refreshRoutes(
  deps: CliDeps,
): Promise<{ handle: AppHandle | undefined; error: DevError | undefined }> {
  if (deps.regenerateRoutes !== undefined) {
    try {
      const result = await deps.regenerateRoutes();

      if (result !== undefined) {
        deps.out(
          `routes refreshed: ${result.path} (${result.count} route ${fileNoun(result.count)})`,
        );
      }
    } catch (cause) {
      // Stderr only: a stale edge manifest does not break the running dev page.
      deps.out(`route manifest refresh failed: ${rebuildErrorMessage(cause)}`);
    }
  }

  if (deps.reloadApp === undefined) return { handle: undefined, error: undefined };

  try {
    const config = await deps.reloadApp();

    // `createApp` rebuilds the dispatch (and re-runs migrations idempotently) over
    // the re-scanned routes; its handle is what the forwarder swaps to.
    const app = await createApp(config);

    return { handle: app.handle, error: undefined };
  } catch (cause) {
    // A syntax error in a just-saved route file would otherwise crash the dev server;
    // keep the prior app live and surface the overlay so the next save recovers.
    deps.out(`app reload failed: ${rebuildErrorMessage(cause)}`);

    return { handle: undefined, error: devError("app-reload", cause) };
  }
}

/** The default dist directory `deploy` ships static artifacts into. */
const DEFAULT_DIST_DIR = "dist";

/** The default signing region for a remote release — R2's value. S3 passes its own. */
const DEFAULT_REMOTE_REGION = "auto";

/**
 * Resolve where a release publishes from the command's flags.
 *
 * Naming a `--bucket` (or `--endpoint`) selects a remote S3/R2 store; together
 * they are required, so a typo in either flag surfaces as a clear
 * `CLI_DEPLOY_INCOMPLETE_REMOTE` rather than silently falling back to local disk.
 * `--region` defaults to `auto` (R2); `--pointer` overrides the live-pointer key.
 * With neither bucket nor endpoint, the target is the local `--dist` store.
 *
 * Credentials are deliberately NOT flags — the bin reads them from the
 * environment when it builds the store — so nothing secret reaches the args.
 */
function releaseTargetFromArgs(args: readonly string[]): ReleaseTarget {
  const bucket = parseStringFlag(args, "bucket");
  const endpoint = parseStringFlag(args, "endpoint");

  if (bucket === undefined && endpoint === undefined) {
    return { kind: "local", distDir: parseStringFlag(args, "dist") ?? DEFAULT_DIST_DIR };
  }

  if (bucket === undefined || endpoint === undefined) {
    throw new CliError(
      "CLI_DEPLOY_INCOMPLETE_REMOTE",
      "a remote release needs both --bucket and --endpoint (credentials come from the environment).",
      { bucket, endpoint },
    );
  }

  const pointerKey = parseStringFlag(args, "pointer");

  return {
    kind: "remote",
    endpoint,
    bucket,
    region: parseStringFlag(args, "region") ?? DEFAULT_REMOTE_REGION,
    // `exactOptionalPropertyTypes` forbids assigning `undefined`; omit when absent.
    ...(pointerKey !== undefined ? { pointerKey } : {}),
  };
}

/** "route" or "routes" — the count noun the deploy output reads with. */
function routeNoun(count: number): string {
  return count === 1 ? "route" : "routes";
}

/** A version stamp from the injected clock — ISO time made path-segment safe. */
function versionStamp(now: () => number): string {
  return new Date(now()).toISOString().replaceAll(/[:.]/g, "-");
}

/**
 * Build the static sites, then ship them and print the deploy plan.
 *
 * Prerenders (failing on a broken page, via `buildStaticSites`), plans the
 * deploy (static targets for the CDN, a `lesto serve` node target for the live
 * tier), ships each static target, and prints the routing manifest — the single
 * source that splits `/` (static) from `/mls/*` (node) at the edge.
 *
 * The default ship is the legacy in-place copy. `--release` upgrades it to a
 * versioned release: every file lands under an immutable `releases/<version>/`
 * tree first and the `current` pointer flips atomically after — so traffic
 * never sees a partial deploy, and `lesto rollback --to <version>` can flip
 * back in one step. `--version <v>` names the release; absent, a timestamp
 * stamp is derived from the injected clock.
 */
/**
 * Deploy to Cloudflare: push the Worker + its Static Assets, then health-gate it.
 *
 * `wrangler deploy` (the driver behind {@link CloudflareDeployer}) ships the
 * Worker and the assets it binds in one atomic, Cloudflare-versioned step — so
 * unlike the static-release path there is no Lesto-owned pointer to flip. What Lesto
 * adds is the gate: probe the live URL after the push and, if it answers
 * unhealthy, roll the Worker back to its previous deployment rather than leave a
 * broken release live (a coded `CLI_DEPLOY_UNHEALTHY`).
 *
 * The probe target is `--health-url` when given, else the URL the driver reported
 * with `/readyz` appended. With neither — the driver could not determine a URL and
 * none was supplied — the deploy still lands but the gate is skipped, and the CLI
 * says so out loud rather than silently shipping ungated.
 */
async function deployToCloudflare(args: readonly string[], deps: CliDeps): Promise<number> {
  const { url } = await deps.cloudflare.deploy();

  const healthUrl =
    parseStringFlag(args, "health-url") ?? (url === undefined ? undefined : `${url}/readyz`);

  if (healthUrl !== undefined && !(await deps.checkHealth(healthUrl))) {
    await deps.cloudflare.rollback();

    throw new CliError(
      "CLI_DEPLOY_UNHEALTHY",
      `Post-deploy health check failed at ${healthUrl}; rolled the Worker back to its previous deployment.`,
      { healthUrl },
    );
  }

  deps.out(url === undefined ? "deployed the Worker" : `deployed → ${url}`);

  deps.out(
    healthUrl === undefined
      ? "health check skipped — no URL to probe (pass --health-url to gate the deploy)"
      : `health check passed: ${healthUrl}`,
  );

  return 0;
}

async function runDeploy(args: readonly string[], deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  const app = await createApp(config);

  const sites = await deps.loadSites();

  const target = parseStringFlag(args, "target");
  const outDir = parseStringFlag(args, "out") ?? DEFAULT_OUT_DIR;

  // Naming a remote bucket implies a release: the remote store is *only* ever a
  // release store (immutable trees + an atomic pointer — there is no in-place
  // remote copy), so `--bucket`/`--endpoint` opt into the release path on their
  // own. This also means remote flags can never silently fall through to a local
  // copy when `--release` is forgotten.
  const release =
    args.includes("--release") ||
    parseStringFlag(args, "bucket") !== undefined ||
    parseStringFlag(args, "endpoint") !== undefined;

  const selected = selectTarget(sites, target);

  // Build the island client (ADR 0011 Seam 3) so `/client.js` + its chunks land
  // in `out/` alongside the prerendered HTML — exactly as `build` does — on every
  // deploy path. Without it a scaffold's deferred island ships a `<script
  // src="/client.js">` that 404s and never hydrates. No-ops when there is no
  // `app/islands/`.
  await buildClientIfPresent(deps, outDir, "production", dialectOf(config));

  // Compile the Tailwind stylesheet to `out/styles.css` on every deploy path too,
  // so a deployed app ships its styles alongside `/client.js` (ADR 0037). No-ops
  // when the project has no CSS entry.
  await buildStylesIfPresent(deps, config, outDir, "production");

  const manifest = await buildStaticSites(selected, app.handle, deps.sink(outDir));

  // Cloudflare ships differently: `wrangler deploy` uploads the Worker AND its
  // bound Static Assets in one atomic step, so the builds above merely freshen
  // `out/` for it — there is no separate static ship or pointer flip here.
  if (args.includes("--cloudflare")) {
    return deployToCloudflare(args, deps);
  }

  const plan = planDeploy(selected, manifest);
  const version = parseStringFlag(args, "version") ?? versionStamp(deps.now);

  // One shipper, chosen up front: the versioned release store (local disk or a
  // remote S3/R2 target, resolved from the flags) or the legacy in-place copy —
  // discriminated so each branch holds its own dependency.
  const shipper: { kind: "release"; store: ReleaseStore } | { kind: "copy"; uploader: ShipDeps } =
    release
      ? { kind: "release", store: deps.releaseStore(releaseTargetFromArgs(args)) }
      : {
          kind: "copy",
          uploader: deps.uploader(parseStringFlag(args, "dist") ?? DEFAULT_DIST_DIR),
        };

  // Track whether any STATIC target actually shipped. An all-dynamic plan (the
  // freshly scaffolded app — one dynamic zone at `/`) ships nothing on this path,
  // so without a closing word `lesto deploy` would print only "run `lesto serve`"
  // and look like a no-op. We name the live-tier paths out loud below instead.
  let shippedStatic = false;

  for (const deployTarget of plan.targets) {
    if (deployTarget.kind !== "static") {
      deps.out(`${deployTarget.site}: run \`${deployTarget.run}\` (dynamic)`);

      continue;
    }

    shippedStatic = true;

    if (shipper.kind === "release") {
      const shipped = await shipRelease(deployTarget, outDir, shipper.store, { version });

      deps.out(
        `released ${shipped.site}: ${shipped.routes.length} ${routeNoun(shipped.routes.length)} (version ${shipped.version})`,
      );

      continue;
    }

    const result = await shipStatic(deployTarget, outDir, shipper.uploader);

    deps.out(`shipped ${result.site}: ${result.routes.length} ${routeNoun(result.routes.length)}`);
  }

  if (shipper.kind === "release") {
    deps.out(`current → ${version}`);
  }

  for (const rule of plan.routing) {
    deps.out(`route ${rule.basePath} → ${rule.mode}`);
  }

  // Nothing static shipped: this default path has no remote tier of its own, so
  // say where the live app goes rather than exit silently. `lesto deploy
  // --cloudflare` is the one-command edge deploy (Worker + assets via wrangler);
  // `lesto serve` is the self-hosted node tier. (A `--release`/remote run DID ship
  // — its own lines already reported it — so this hint is for the bare default.)
  if (!shippedStatic && shipper.kind === "copy") {
    deps.out(
      "no static routes to ship — deploy the live app with `lesto deploy --cloudflare` " +
        "(Worker + assets via wrangler) or self-host it with `lesto serve`",
    );
  }

  return 0;
}

/**
 * Flip the live pointer back to an already-published release.
 *
 * `--to <version>` names the target (required; refusing to guess is the point
 * of a rollback under pressure); the release store is located the same way
 * `deploy --release` chose it — `--dist <dir>` for local disk, or
 * `--bucket`/`--endpoint` for a remote S3/R2 store. The flip is the same atomic
 * pointer move a deploy ends with, and an unknown version is refused by the
 * store (`DEPLOY_UNKNOWN_RELEASE`) rather than pointing the site at nothing.
 */
async function runRollback(args: readonly string[], deps: CliDeps): Promise<number> {
  const version = parseStringFlag(args, "to");

  if (version === undefined) {
    throw new CliError(
      "CLI_ROLLBACK_MISSING_VERSION",
      "rollback needs the release to flip to: lesto rollback --to <version>",
      {},
    );
  }

  const result = await rollback(deps.releaseStore(releaseTargetFromArgs(args)), version);

  deps.out(
    result.from === undefined
      ? `now serving ${result.to}`
      : `rolled back: ${result.from} → ${result.to}`,
  );

  return 0;
}

/** Print usage. Shared by `help`, the empty command, and unknown commands. */
function printUsage(deps: CliDeps): void {
  deps.out(USAGE);
}

/**
 * Dispatch one CLI invocation.
 *
 * `argv` is the args *after* the binary name: the first token is the command,
 * the rest are its options. Returns the process exit code. Unknown commands are
 * a hard error (a stable `CLI_UNKNOWN_COMMAND`); help and the empty command are
 * a soft success that prints usage.
 */
export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...args] = argv;

  if (command === "routes") return runRoutes(deps);

  if (command === "routes:gen") return runRoutesGen(deps);

  if (command === "migrate") return runMigrate(deps);

  if (command === "serve") return runServe(args, deps);

  if (command === "dev") return runDev(args, deps);

  if (command === "build") return runBuild(args, deps);

  if (command === "deploy") return runDeploy(args, deps);

  if (command === "rollback") return runRollback(args, deps);

  if (command === "content:build") return runContentBuild(args, deps);

  if (command === "content:new") return runContentNew(args, deps);

  if (command === "content:delete") return runContentDelete(args, deps);

  // No command, or an explicit ask for help: print usage and succeed.
  if (command === undefined || command === "" || command === "help") {
    printUsage(deps);

    return 0;
  }

  // Anything else is a mistake the caller must fix — surface it by code.
  throw new CliError("CLI_UNKNOWN_COMMAND", `Unknown command: "${command}".`, { command });
}
