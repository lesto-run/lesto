/**
 * Bundle an app's island hydration client — the framework-owned client pipeline
 * (ADR 0011, Seam 2), absorbing what estate hand-wrote in `build-client.ts`.
 *
 * The orchestration is pure logic over injected seams (discover islands, write
 * the entry, sweep stale chunks), so it is tested without a bundler or a disk;
 * the real `Bun.build` + `node:fs` wiring lives in `bun.ts` (the default deps,
 * which the coverage gate excludes exactly as it excludes a `bin`).
 *
 * The order is the contract: discover the islands → synthesize the entry from
 * their declarations → bundle → sweep the *previous* build's hashed chunks
 * (only after a successful build, so a failed rebuild leaves the last good
 * output intact) → write the entry + this build's chunks.
 */

import { join } from "node:path";

import { isChunkFile } from "./chunks";
import { AssetsError } from "./errors";
import { synthesizeEntry } from "./synthesize";
import type { IslandFile } from "./synthesize";

/** Which component runtime the client bundle resolves to. */
export type Dialect = "react" | "preact";

/** A development (unminified) or production (minified, `NODE_ENV=production`) build. */
export type BuildMode = "development" | "production";

/** What to build and where to put it. */
export interface BuildClientOptions {
  /** The `app/islands/` directory whose modules become the client registry. */
  readonly islandsDir: string;

  /** Where `client.js` + its chunks are written. */
  readonly outDir: string;

  /** The entry file name. Defaults to `client.js`. */
  readonly entryName?: string;

  readonly mode: BuildMode;

  readonly dialect: Dialect;
}

/** One artifact a bundle produced — the entry, or a content-hashed split chunk. */
export interface BundleArtifact {
  readonly kind: "entry" | "chunk";

  /** The artifact's file name (a chunk's hashed `chunk-<hash>.js`; the entry uses `entryName`). */
  readonly fileName: string;

  readonly contents: string | Uint8Array;
}

/** What the bundler seam is asked to compile. */
export interface BundleRequest {
  readonly entrySource: string;

  readonly mode: BuildMode;

  readonly dialect: Dialect;
}

/** The injected seams `buildClient` orchestrates over — real implementations in `bun.ts`. */
export interface BuildClientDeps {
  /** Discover island modules under the dir, classified eager/lazy by their declared hydrate strategy. */
  listIslands(islandsDir: string): Promise<readonly IslandFile[]>;

  /** Compile the synthesized entry; returns the entry + chunk artifacts. Throws on a failed build. */
  bundle(request: BundleRequest): Promise<readonly BundleArtifact[]>;

  /** The names of files currently in the out dir (for the stale-chunk sweep). */
  listOutDir(outDir: string): Promise<readonly string[]>;

  /** Remove a file. */
  remove(path: string): Promise<void>;

  /** Write a file. */
  write(path: string, contents: string | Uint8Array): Promise<void>;
}

/** What a build produced: the written paths and the islands it bundled. */
export interface BuildClientResult {
  readonly entry: string;

  readonly chunks: readonly string[];

  readonly islands: readonly IslandFile[];
}

/** The default entry file name when none is given. */
const DEFAULT_ENTRY = "client.js";

/**
 * Build the client for `options` through the injected `deps`.
 *
 * Pure orchestration: every effect (read islands, bundle, list/remove/write
 * files) is a seam, so the sequence and the stale-chunk sweep are tested with
 * fakes. An empty `app/islands/` still produces a (no-op) entry, which a page
 * loads harmlessly.
 */
export async function buildClient(
  options: BuildClientOptions,
  deps: BuildClientDeps,
): Promise<BuildClientResult> {
  const islands = await deps.listIslands(options.islandsDir);

  const entrySource = synthesizeEntry(islands);

  const artifacts = await deps.bundle({
    entrySource,
    mode: options.mode,
    dialect: options.dialect,
  });

  const entryArtifact = artifacts.find((artifact) => artifact.kind === "entry");

  if (entryArtifact === undefined) {
    throw new AssetsError("ASSETS_NO_ENTRY", "the bundler produced no entry-point artifact", {
      islandsDir: options.islandsDir,
    });
  }

  // Sweep the previous build's hashed chunks before writing this build's, so the
  // out dir holds exactly the current graph and nothing stale ships. Only after a
  // successful build (we are past the bundle + entry checks).
  for (const name of await deps.listOutDir(options.outDir)) {
    if (isChunkFile(name)) {
      await deps.remove(join(options.outDir, name));
    }
  }

  const entryPath = join(options.outDir, options.entryName ?? DEFAULT_ENTRY);

  await deps.write(entryPath, entryArtifact.contents);

  const chunks: string[] = [];

  for (const artifact of artifacts) {
    if (artifact.kind === "entry") continue;

    const chunkPath = join(options.outDir, artifact.fileName);

    await deps.write(chunkPath, artifact.contents);

    chunks.push(chunkPath);
  }

  return { entry: entryPath, chunks, islands };
}
