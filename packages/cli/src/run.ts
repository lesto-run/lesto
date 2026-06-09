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
import type { AppConfig } from "@keel/kernel";

import { deleteEntry, persistEntries, pruneEntries } from "@keel/content-store";
import type { RuntimeEntry } from "@keel/content-core";

import { buildStaticSites } from "@keel/sites";
import type { OutputSink, Site } from "@keel/sites";

import { dispatchSitesDev } from "@keel/runtime";
import type { serve, StaticReader } from "@keel/runtime";

import { planDeploy, shipStatic } from "@keel/deploy";
import type { ShipDeps } from "@keel/deploy";

import { CliError } from "./errors";
import { parsePort, parseStringFlag } from "./flags";

/** The default port for `serve`/`dev` when no `--port` flag is given. */
const DEFAULT_PORT = 3000;

/** The seams the command core depends on — all injected, never imported live. */
export interface CliDeps {
  /** Load the project's app config (the bin reads `keel.app.ts`; tests fake it). */
  loadApp: () => Promise<AppConfig>;

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

  /** Build a static-deploy uploader rooted at `distDir` (the bin passes `nodeUploader`). */
  uploader: (distDir: string) => ShipDeps;

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
  "  deploy            Build and ship static sites; print the routing plan (--target, --out, --dist)",
  "  content:build     Compile markdown content into the content store (--prune drops stale rows)",
  "  content:new       Scaffold a new content entry: content:new <collection> <title>",
  "  content:delete    Delete a content entry: content:delete <collection> <slug>",
  "  help              Show this help",
].join("\n");

/** Print every route the app's router declares, one per line. */
async function runRoutes(deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  for (const route of config.router.list()) {
    deps.out(`${route.method}\t${route.pattern}\t${route.target}`);
  }

  return 0;
}

/** Boot the app (which runs migrations) and print the versions that applied. */
async function runMigrate(deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  const app = createApp(config);

  for (const version of app.migrationsApplied) {
    deps.out(`applied ${version}`);
  }

  return 0;
}

/**
 * Boot the app and stand a server in front of it, printing the listening URL.
 *
 * Resolves once the server is listening — the core does not block forever; the
 * bin is what keeps the process alive after this returns.
 */
async function runServe(args: readonly string[], deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  const app = createApp(config);

  const { port } = parsePort(args, DEFAULT_PORT);

  const server = await deps.serve(app, { port });

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

  createApp(config);

  const entries = await deps.buildContent();

  const { persisted } = persistEntries(config.db, entries);

  deps.out(`built ${persisted} ${entryNoun(persisted)} into the content store`);

  // `--prune` makes the store mirror the build: rows for source that no longer
  // exists are dropped. Opt-in, because a misconfigured build would otherwise
  // wipe content.
  if (args.includes("--prune")) {
    const { deleted } = pruneEntries(config.db, entries);

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

  createApp(config);

  const { deleted } = deleteEntry(config.db, collection, slug);

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
 * Prerender the project's static sites to disk.
 *
 * Boots the app, loads its declared sites, and hands the app's own `handle` to
 * `buildStaticSites` — which fails the build on any page that did not render
 * before writing a single file. `--target <name>` builds one site; `--out <dir>`
 * picks the output root (default `out`). One line per built site reports its
 * page count.
 */
async function runBuild(args: readonly string[], deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  const app = createApp(config);

  const sites = await deps.loadSites();

  const target = parseStringFlag(args, "target");
  const outDir = parseStringFlag(args, "out") ?? DEFAULT_OUT_DIR;

  const selected = selectTarget(sites, target);

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
 */
async function runDev(args: readonly string[], deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  const app = createApp(config);

  const sites = await deps.loadSites();

  const dispatch = dispatchSitesDev({
    sites,
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

/**
 * Build the static sites, then ship them and print the deploy plan.
 *
 * Prerenders (failing on a broken page, via `buildStaticSites`), plans the
 * deploy (static targets for the CDN, a `keel serve` node target for the live
 * tier), ships each static target through the injected uploader, and prints the
 * routing manifest — the single source that splits `/` (static) from `/mls/*`
 * (node) at the edge.
 */
async function runDeploy(args: readonly string[], deps: CliDeps): Promise<number> {
  const config = await deps.loadApp();

  const app = createApp(config);

  const sites = await deps.loadSites();

  const target = parseStringFlag(args, "target");
  const outDir = parseStringFlag(args, "out") ?? DEFAULT_OUT_DIR;
  const distDir = parseStringFlag(args, "dist") ?? DEFAULT_DIST_DIR;

  const selected = selectTarget(sites, target);

  const manifest = await buildStaticSites(selected, app.handle, deps.sink(outDir));

  const plan = planDeploy(selected, manifest);
  const uploader = deps.uploader(distDir);

  for (const deployTarget of plan.targets) {
    if (deployTarget.kind === "static") {
      const result = await shipStatic(deployTarget, outDir, uploader);

      deps.out(
        `shipped ${result.site}: ${result.routes.length} ${routeNoun(result.routes.length)}`,
      );
    } else {
      deps.out(`${deployTarget.site}: run \`${deployTarget.run}\` (dynamic)`);
    }
  }

  for (const rule of plan.routing) {
    deps.out(`route ${rule.basePath} → ${rule.mode}`);
  }

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
