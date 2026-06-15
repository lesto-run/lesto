/**
 * The CLI's pure command core.
 *
 * `run` is the whole brain of the `keel` tool, with every real-world dependency
 * injected: how to load the project's app, how to serve it, and where output
 * goes. That seam is what makes the core fully testable — a test hands `run` a
 * fake `loadApp`, a spy `serve`, and a capturing `out`, and asserts on exactly
 * what was printed and called, with no filesystem, no sockets, and no process.
 *
 * The thin `bin.ts` builds the real dependencies (a dynamic import of the
 * project's `keel.app.ts`, the real `@keel/runtime` serve, `console.log`) and
 * keeps the process alive for long-running commands. Everything decided here is
 * covered; only that wiring is excluded.
 */

import { createApp } from "@keel/kernel";
import type { AppConfig, KeelAppConfig, KernelDatabase } from "@keel/kernel";
import type { UiDialect } from "@keel/web";

import { deleteEntry, persistEntries, pruneEntries } from "@keel/content-store";
import type { RuntimeEntry } from "@keel/content-core";

import { buildStaticSites } from "@keel/sites";
import type { OutputSink, Site } from "@keel/sites";

import { dispatchSitesDev } from "@keel/runtime";
import type { serve, StaticReader } from "@keel/runtime";

import { planDeploy, rollback, shipRelease, shipStatic } from "@keel/deploy";
import type { ReleaseStore, ShipDeps } from "@keel/deploy";

import { CliError } from "./errors";
import { parsePort, parseStringFlag } from "./flags";

/** The default port for `serve`/`dev` when no `--port` flag is given. */
const DEFAULT_PORT = 3000;

/**
 * The synthetic single site `dev` falls back to when a project declares none (a
 * missing `keel.sites.ts`): one dynamic zone at the root, so every path is
 * dispatched live to the app. The whole-app, no-zones default — the scaffold's
 * first-boot shape — instead of a hard crash or a 404 on every route (blocker #9).
 */
const APP_ONLY_SITE: Site = { name: "app", render: "dynamic", basePath: "/" };

/** The seams the command core depends on — all injected, never imported live. */
export interface CliDeps {
  /**
   * Load the project's app config (the bin reads `keel.app.ts`; tests fake it).
   *
   * Either shape `createApp` accepts: the code-first `keel()` app
   * ({@link KeelAppConfig}) or the legacy `{ router, controllers }`
   * ({@link AppConfig}). Both are supported until the legacy surface is removed
   * (ADR 0004 Phase 7.6).
   */
  loadApp: () => Promise<AppConfig | KeelAppConfig>;

  /** Stand a real server in front of the app (the bin passes `@keel/runtime`'s). */
  serve: typeof serve;

  /**
   * Run the content pipeline and return its entries (the bin passes
   * `@keel/content-core`'s `runPipeline`; tests fake it). The content commands
   * persist whatever this yields, so the filesystem-reading pipeline stays out
   * of the covered core.
   */
  buildContent: () => Promise<readonly RuntimeEntry[]>;

  /** Scaffold a new entry into a collection (the bin passes `createNewEntry`). */
  createEntry: (collection: string, title: string) => Promise<void>;

  /** Load the project's declared sites (the bin imports `keel.sites.ts`'s default). */
  loadSites: () => Promise<readonly Site[]>;

  /** Build a sink rooted at `outDir` for the static build (the bin passes `nodeSink`). */
  sink: (outDir: string) => OutputSink;

  /**
   * Read a client build asset (e.g. `/client.js`) for the dev server, or absent
   * to disable asset serving. The bin passes `nodeStaticReader` over the asset
   * dir; without it, `keel dev` still live-renders every zone — islands just show
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
   * Build the project's island client bundle (`@keel/assets`, ADR 0011 Seam 3).
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
   * Watch `app/islands/` and call `onChange` (debounced) when a module changes,
   * returning a stop handle. The bin wires this to a debounced `fs.watch`; the
   * CLI core just registers the rebuild. Absent → no watching (a one-shot dev
   * build on boot, no live rebuilds).
   */
  watchIslands?: (onChange: () => void) => () => void;

  /** Build a static-deploy uploader rooted at `distDir` (the bin passes `nodeUploader`). */
  uploader: (distDir: string) => ShipDeps;

  /**
   * Build a versioned release store rooted at `distDir` (the bin passes
   * `nodeReleaseStore`). Backs `deploy --release` and `rollback`: immutable
   * `releases/<version>/` trees behind an atomically-flipped `current` pointer.
   */
  releaseStore: (distDir: string) => ReleaseStore;

  /** The clock release version stamps derive from (the bin passes `Date.now`). */
  now: () => number;

  /**
   * Register a graceful-shutdown hook for the long-running `serve`/`dev`
   * commands: the bin wires SIGTERM/SIGINT to drain the server and exit, so a
   * deploy's rolling restart lets in-flight requests finish instead of severing
   * them. Absent in tests and for one-shot commands, which never linger.
   */
  installShutdown?: (drain: () => Promise<void>) => void;

  /** Where a line of output goes (the bin passes `console.log`). */
  out: (line: string) => void;
}

/** The usage text printed for `help`, an empty command, or an unknown command. */
const USAGE = [
  "keel — the Keel command-line tool",
  "",
  "Usage: keel <command> [options]",
  "",
  "Commands:",
  "  routes            List the application's routes",
  "  migrate           Run pending migrations and print the applied versions",
  "  serve             Boot the app over HTTP (--port, default 3000)",
  "  dev               Run every site live on one origin for local development (--port)",
  "  build             Prerender static sites to disk (--target <name>, --out <dir>, default out)",
  "  deploy            Build and ship static sites; print the routing plan (--target, --out, --dist;",
  "                    --release for a versioned, atomically-flipped release, --version <v> to name it)",
  "  rollback          Flip the live pointer to a published release: rollback --to <version> (--dist)",
  "  content:build     Compile markdown content into the content store (--prune drops stale rows)",
  "  content:new       Scaffold a new content entry: content:new <collection> <title>",
  "  content:delete    Delete a content entry: content:delete <collection> <slug>",
  "  help              Show this help",
].join("\n");

/** Print every route the app declares, one per line. */
async function runRoutes(deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  // The code-first `keel()` app exposes its routes as `{ method, pattern }`.
  // The legacy `Router` additionally carries a `controller#action` target. Both
  // are listed here until the legacy surface is removed (ADR 0004 Phase 7.6).
  if ("app" in config) {
    for (const route of config.app.routes()) {
      deps.out(`${route.method}\t${route.pattern}`);
    }

    return 0;
  }

  for (const route of config.router.list()) {
    deps.out(`${route.method}\t${route.pattern}\t${route.target}`);
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
 * Boot the app and stand a server in front of it, printing the listening URL.
 *
 * Resolves once the server is listening — the core does not block forever; the
 * bin is what keeps the process alive after this returns. `/readyz` is wired to
 * a real database ping so it reports the node's true readiness, not a constant.
 */
async function runServe(args: readonly string[], deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  const app = await createApp(config);

  const { port } = parsePort(args, DEFAULT_PORT);

  const server = await deps.serve(app, {
    port,
    health: { isReady: databaseReady(config.db) },
  });

  deps.installShutdown?.(() => server.close());

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

  const { persisted } = await persistEntries(config.db, entries);

  deps.out(`built ${persisted} ${entryNoun(persisted)} into the content store`);

  // `--prune` makes the store mirror the build: rows for source that no longer
  // exists are dropped. Opt-in, because a misconfigured build would otherwise
  // wipe content.
  if (args.includes("--prune")) {
    const { deleted } = await pruneEntries(config.db, entries);

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
      "content:new needs a collection and a title: keel content:new <collection> <title>",
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
      "content:delete needs a collection and a slug: keel content:delete <collection> <slug>",
      { collection, slug },
    );
  }

  const config = await deps.loadApp();

  await createApp(config);

  const { deleted } = await deleteEntry(config.db, collection, slug);

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
 * bin wires to the real filesystem + `@keel/assets`; absent, the CLI never builds
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
 * Read from `config.ui.dialect`; absent (or the legacy `{ router }` shape, which
 * has no `ui` field) defaults to `"react"`. The CLI hands this to the client
 * build, while `createApp` wires the server renderer from the same key — so the
 * client alias and the server renderer are always the same dialect.
 */
function dialectOf(config: AppConfig | KeelAppConfig): UiDialect {
  return "ui" in config && config.ui !== undefined ? config.ui.dialect : "react";
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

  const manifest = await buildStaticSites(selected, app.handle, deps.sink(outDir));

  for (const site of manifest) {
    deps.out(`built ${site.site}: ${site.pages.length} ${pageNoun(site.pages.length)}`);
  }

  return 0;
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
 */
async function runDev(args: readonly string[], deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  const app = await createApp(config);

  const sites = await deps.loadSites();

  // The matched pair's client half (ADR 0008): the same `ui.dialect` key
  // `createApp` just wired the server renderer from also picks the client alias,
  // so dev's bundle and its server render speak one dialect.
  const dialect = dialectOf(config);

  // Build the island client on boot, then watch for changes. The dev outDir is
  // the same root the bin's `readAsset` serves from (DEFAULT_OUT_DIR).
  await buildClientIfPresent(deps, DEFAULT_OUT_DIR, "dev", dialect);

  // A change rebuilds the bundle; a rebuild failure during dev is reported, not
  // fatal — the dev server stays up so the next save can fix it. The coded
  // `CliError`'s `details.cause` is the bundler's own error, the message worth
  // showing.
  if (deps.hasIslandsDir !== undefined && (await deps.hasIslandsDir())) {
    deps.watchIslands?.(() => {
      void buildClientIfPresent(deps, DEFAULT_OUT_DIR, "dev", dialect).catch((error: unknown) => {
        deps.out(`client rebuild failed: ${rebuildErrorMessage(error)}`);
      });
    });
  }

  // Tolerate an app with no declared sites (a missing `keel.sites.ts`, which the
  // bin's loader resolves to `[]`): dispatch every path straight to the app, so a
  // freshly scaffolded app boots and serves before its author writes a sites file.
  // A declared site set routes as before.
  const dispatch = dispatchSitesDev({
    sites: sites.length === 0 ? [APP_ONLY_SITE] : sites,
    handle: app.handle,
    ...(deps.readAsset === undefined ? {} : { readAsset: deps.readAsset }),
  });

  const { port } = parsePort(args, DEFAULT_PORT);

  // Wrap the dev dispatcher as the app the server fronts; migrations already ran.
  const server = await deps.serve(
    { handle: dispatch, migrationsApplied: app.migrationsApplied },
    { port },
  );

  deps.installShutdown?.(() => server.close());

  deps.out(`dev server on http://127.0.0.1:${server.port}`);

  return 0;
}

/** The default dist directory `deploy` ships static artifacts into. */
const DEFAULT_DIST_DIR = "dist";

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
 * deploy (static targets for the CDN, a `keel serve` node target for the live
 * tier), ships each static target, and prints the routing manifest — the single
 * source that splits `/` (static) from `/mls/*` (node) at the edge.
 *
 * The default ship is the legacy in-place copy. `--release` upgrades it to a
 * versioned release: every file lands under an immutable `releases/<version>/`
 * tree first and the `current` pointer flips atomically after — so traffic
 * never sees a partial deploy, and `keel rollback --to <version>` can flip
 * back in one step. `--version <v>` names the release; absent, a timestamp
 * stamp is derived from the injected clock.
 */
async function runDeploy(args: readonly string[], deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  const app = await createApp(config);

  const sites = await deps.loadSites();

  const target = parseStringFlag(args, "target");
  const outDir = parseStringFlag(args, "out") ?? DEFAULT_OUT_DIR;
  const distDir = parseStringFlag(args, "dist") ?? DEFAULT_DIST_DIR;
  const release = args.includes("--release");

  const selected = selectTarget(sites, target);

  const manifest = await buildStaticSites(selected, app.handle, deps.sink(outDir));

  const plan = planDeploy(selected, manifest);
  const version = parseStringFlag(args, "version") ?? versionStamp(deps.now);

  // One shipper, chosen up front: the versioned release store or the legacy
  // in-place copy — discriminated so each branch holds its own dependency.
  const shipper: { kind: "release"; store: ReleaseStore } | { kind: "copy"; uploader: ShipDeps } =
    release
      ? { kind: "release", store: deps.releaseStore(distDir) }
      : { kind: "copy", uploader: deps.uploader(distDir) };

  for (const deployTarget of plan.targets) {
    if (deployTarget.kind !== "static") {
      deps.out(`${deployTarget.site}: run \`${deployTarget.run}\` (dynamic)`);

      continue;
    }

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

  return 0;
}

/**
 * Flip the live pointer back to an already-published release.
 *
 * `--to <version>` names the target (required; refusing to guess is the point
 * of a rollback under pressure); `--dist <dir>` locates the release store. The
 * flip is the same atomic pointer move a deploy ends with, and an unknown
 * version is refused by the store (`DEPLOY_UNKNOWN_RELEASE`) rather than
 * pointing the site at nothing.
 */
async function runRollback(args: readonly string[], deps: CliDeps): Promise<number> {
  const version = parseStringFlag(args, "to");

  if (version === undefined) {
    throw new CliError(
      "CLI_ROLLBACK_MISSING_VERSION",
      "rollback needs the release to flip to: keel rollback --to <version>",
      {},
    );
  }

  const distDir = parseStringFlag(args, "dist") ?? DEFAULT_DIST_DIR;

  const result = await rollback(deps.releaseStore(distDir), version);

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
