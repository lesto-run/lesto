#!/usr/bin/env bun
/**
 * The `keel` executable — pure wiring, no logic.
 *
 * It builds the real dependencies (load the project's `keel.app.ts`, the real
 * runtime `serve`, `console.log`) and hands them to the covered `run` core.
 * `serve`/`dev` resolve once listening; the process stays alive on its own
 * open socket, so we only exit non-`serve` commands.
 */

import { join } from "node:path";

import { nodeStaticReader, serve } from "@keel/runtime";
import type { AppConfig } from "@keel/kernel";

import { createNewEntry, runPipeline } from "@keel/content-core/build";
import type { RuntimeEntry } from "@keel/content-core";

import { nodeSink } from "@keel/sites";
import type { Site } from "@keel/sites";

import { nodeUploader } from "@keel/deploy";

import { run } from "./run";

/** Where `keel dev` looks for built client assets (e.g. a bundled `/client.js`). */
const DEV_ASSET_DIR = "out";

const argv = process.argv.slice(2);

const loadApp = async (): Promise<AppConfig> => {
  const module = (await import(join(process.cwd(), "keel.app.ts"))) as { default: AppConfig };

  return module.default;
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
  uploader: nodeUploader,
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
