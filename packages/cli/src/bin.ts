#!/usr/bin/env bun
/**
 * The `keel` executable — pure wiring, no logic.
 *
 * It builds the real dependencies (load the project's `keel.app.ts`, the real
 * runtime `serve`, `console.log`) and hands them to the covered `run` core.
 * `serve`/`dev` resolve once listening; the process stays alive on its own
 * open socket, so we only exit non-`serve` commands.
 */

import { access } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";

import { nodeStaticReader, serve } from "@keel/runtime";
import type { KeelAppConfig } from "@keel/kernel";
import type { UiDialect } from "@keel/web";

import { createNewEntry, runPipeline } from "@keel/content-core/build";
import type { RuntimeEntry } from "@keel/content-core";

import { nodeSink } from "@keel/sites";
import type { Site } from "@keel/sites";

import { nodeReleaseStore, nodeUploader } from "@keel/deploy";

import { buildClient, bunBuildClientDeps } from "@keel/assets";

import { run } from "./run";

/** Where `keel dev` looks for built client assets (e.g. a bundled `/client.js`). */
const DEV_ASSET_DIR = "out";

/** The project's island-convention directory (ADR 0011) — its presence enables the client build. */
const ISLANDS_DIR = "app/islands";

/** Debounce window for the dev island watcher: coalesce a burst of saves into one rebuild. */
const WATCH_DEBOUNCE_MS = 100;

const argv = process.argv.slice(2);

const projectRoot = process.cwd();

const islandsDir = join(projectRoot, ISLANDS_DIR);

const loadApp = async (): Promise<KeelAppConfig> => {
  const module = (await import(join(process.cwd(), "keel.app.ts"))) as {
    default: KeelAppConfig;
  };

  return module.default;
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

// Build the island client bundle with @keel/assets. The CLI core's "dev" mode
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

// Run the pipeline for its entries; the project's keel.app.ts owns the cwd and
// the collections, so the bin needs no arguments here.
const buildContent = async (): Promise<readonly RuntimeEntry[]> =>
  (await runPipeline({ skipWrite: true })).entries;

const createEntry = (collection: string, title: string): Promise<void> =>
  createNewEntry(process.cwd(), collection, title);

// The project declares its sites in `keel.sites.ts`, mirroring `keel.app.ts`;
// the build reads its default export. A MISSING file is tolerated, not fatal: it
// resolves to no sites, and the CLI core falls back to app-only dispatch (a fresh
// scaffold boots before its author writes a sites file — blocker #9). Any OTHER
// import error (a syntax error in an existing file) is rethrown, so a real bug in
// the sites file is not silently swallowed as "no sites".
const SITES_PATH = join(process.cwd(), "keel.sites.ts");

const loadSites = async (): Promise<readonly Site[]> => {
  try {
    const module = (await import(SITES_PATH)) as { default: readonly Site[] };

    return module.default;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
      // Distinguish "the sites file is absent" from "a module it imports is
      // missing": only the former — the sites file itself not existing — is the
      // tolerated empty-sites case. A missing transitive import is a real error.
      if ((error as { message: string }).message.includes("keel.sites.ts")) return [];
    }

    throw error;
  }
};

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
  releaseStore: nodeReleaseStore,
  now: Date.now,
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
