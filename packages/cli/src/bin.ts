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
import type { AppConfig, KeelAppConfig } from "@keel/kernel";

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

const loadApp = async (): Promise<AppConfig | KeelAppConfig> => {
  const module = (await import(join(process.cwd(), "keel.app.ts"))) as {
    default: AppConfig | KeelAppConfig;
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
// maps to an unminified build; "production" to the minified one. Dialect is
// "react" for now — the `ui.dialect` config key is Increment 2/3 scope (TODO:
// ADR 0011 Seam 2 — drive dialect from keel.config so dev == prod under preact).
const buildClientAssets = async (options: {
  outDir: string;
  mode: "dev" | "production";
}): Promise<void> => {
  await buildClient(
    {
      islandsDir,
      outDir: join(projectRoot, options.outDir),
      mode: options.mode === "dev" ? "development" : "production",
      dialect: "react",
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
// the build reads its default export.
const loadSites = async (): Promise<readonly Site[]> => {
  const module = (await import(join(process.cwd(), "keel.sites.ts"))) as {
    default: readonly Site[];
  };

  return module.default;
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
