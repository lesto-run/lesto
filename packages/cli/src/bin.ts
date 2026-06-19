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
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, join } from "node:path";

import { nodeStaticReader, serve } from "@lesto/runtime";
import type { LestoAppConfig } from "@lesto/kernel";
import type { UiDialect } from "@lesto/web";
import type { TraceSeams } from "@lesto/observability";

import { createNewEntry, runPipeline } from "@lesto/content-core/build";
import type { RuntimeEntry } from "@lesto/content-core";

import { nodeSink } from "@lesto/sites";
import type { Site } from "@lesto/sites";

import { nodeReleaseStore, nodeUploader, remoteReleaseStore } from "@lesto/deploy";
import type { ReleaseStore } from "@lesto/deploy";

import { buildClient, bunBuildClientDeps } from "@lesto/assets";

import { createApp } from "@lesto/kernel";

import { run } from "./run";
import type { CloudflareDeployer, ReleaseTarget } from "./run";
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

const loadApp = async (seams?: TraceSeams): Promise<LestoAppConfig> => {
  const module = (await import(join(process.cwd(), "lesto.app.ts"))) as {
    default: AppDefault;
  };

  const exported = module.default;

  return typeof exported === "function" ? exported(seams) : exported;
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

// Run the pipeline for its entries; the project's lesto.app.ts owns the cwd and
// the collections, so the bin needs no arguments here.
const buildContent = async (): Promise<readonly RuntimeEntry[]> =>
  (await runPipeline({ skipWrite: true })).entries;

const createEntry = (collection: string, title: string): Promise<void> =>
  createNewEntry(process.cwd(), collection, title);

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

const code = await run(argv, {
  loadApp,
  serve,
  buildContent,
  createEntry,
  loadSites,
  sink: nodeSink,
  readAsset: nodeStaticReader(join(process.cwd(), DEV_ASSET_DIR)),
  hasIslandsDir,
  buildClientAssets,
  watchIslands,
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
