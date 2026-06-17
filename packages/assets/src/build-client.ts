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

  /**
   * The maximum gzipped size, in bytes, the client ENTRY may reach before the
   * build fails with `ASSETS_BUDGET_EXCEEDED`. The regression guard the
   * standalone `bundle-size` script asserts in CI (react ≤ 65 KB, preact ≤ 15 KB,
   * ADR 0007/0011), now enforceable INSIDE the build so a configured app fails its
   * own `keel build` on a blown budget. Omitted = measure-and-report only, never
   * fail (the size still rides into {@link BuildClientResult} and the report).
   */
  readonly budgetBytes?: number;

  /**
   * Where the build narrates what it decided — per-artifact gzip sizes, the
   * budget verdict (ADR 0011: "the build narrates what it decided"). Defaults to a
   * no-op; the CLI wires `console.log`. A seam, not a global, so the narration is
   * asserted in a test.
   */
  readonly report?: BuildReport;
}

/** One line of build narration. */
export type BuildReport = (line: string) => void;

/** The gzipped size of one written artifact, in bytes — the report + budget unit. */
export interface ArtifactSize {
  readonly fileName: string;

  readonly kind: "entry" | "chunk";

  readonly gzipBytes: number;
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

  /** Read a file's text, or `undefined` if it does not exist (the prior-generation marker). */
  read(path: string): Promise<string | undefined>;

  /** Remove a file. */
  remove(path: string): Promise<void>;

  /** Write a file. */
  write(path: string, contents: string | Uint8Array): Promise<void>;

  /**
   * The gzipped byte length of `contents` — the size unit the report + budget use
   * (a network-meaningful number; raw bytes mislead since every byte ships
   * gzipped). Injected (real impl: `node:zlib` `gzipSync` in `bun.ts`) so the
   * measure/report/budget logic is exercised under vitest with a fake.
   */
  gzipSize(contents: string | Uint8Array): number;
}

/** What a build produced: the written paths, the islands it bundled, and per-artifact sizes. */
export interface BuildClientResult {
  readonly entry: string;

  readonly chunks: readonly string[];

  readonly islands: readonly IslandFile[];

  /** The gzipped size of the entry and each chunk — what the build measured + reported. */
  readonly sizes: readonly ArtifactSize[];
}

/** The default entry file name when none is given. */
const DEFAULT_ENTRY = "client.js";

/**
 * The prior-generation marker: a production build records the chunk file names it
 * wrote here, so the NEXT production build knows which chunks are the one
 * generation to retain (everything older is swept). Hidden so it is never mistaken
 * for an asset and never served.
 */
const GENERATION_MARKER = ".keel-chunks.json";

/** Parse the generation marker's chunk-name list; tolerate a missing/corrupt marker. */
function parseGeneration(contents: string | undefined): readonly string[] {
  if (contents === undefined) return [];

  try {
    const parsed: unknown = JSON.parse(contents);

    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Build the client for `options` through the injected `deps`.
 *
 * Pure orchestration: every effect (read islands, bundle, read/list/remove/write
 * files) is a seam, so the sequence and the stale-chunk sweep are tested with
 * fakes. An empty `app/islands/` still produces a (no-op) entry, which a page
 * loads harmlessly.
 *
 * WRITE-THEN-SWEEP, not sweep-then-write. The new artifacts are written FIRST,
 * then anything stale is removed — never the reverse. Two failure modes this
 * closes:
 *
 *   - A crash BETWEEN phases leaves a fully-written new build on disk (plus, at
 *     worst, some harmless stale chunks). Sweeping first risked a crash that left
 *     the out dir with the old chunks gone and the new ones not yet written — a
 *     half-empty, unservable directory.
 *   - A rebuild WHILE an old document is in flight. A client (or a CDN-cached
 *     `index.html`) that already fetched the previous `client.js` may still be
 *     requesting that generation's hashed chunks. Sweeping them before the new
 *     build is even written 404s those chunks mid-rebuild. Hashed names make
 *     keeping both generations safe — they never collide.
 *
 * The sweep policy is mode-aware. Development sweeps every chunk not in the new
 * build (a clean dir, no CDN, no in-flight concern). Production keeps exactly ONE
 * previous generation — the chunks the LAST production build wrote, recorded in a
 * {@link GENERATION_MARKER} — so an in-flight old document still resolves its
 * chunks, while a third generation does not accumulate unbounded.
 */
export async function buildClient(
  options: BuildClientOptions,
  deps: BuildClientDeps,
): Promise<BuildClientResult> {
  // Narration is opt-in: a no-op unless the caller (the CLI) wires a report sink.
  const report: BuildReport = options.report ?? (() => {});

  const islands = await deps.listIslands(options.islandsDir);

  // The matched pair (ADR 0008): the `preact` dialect aliases only the CLIENT
  // bundle react→preact/compat. The CLI's server renderer stays React (its
  // process is NOT aliased), which is sound for deferred (`ssr: false`) islands —
  // they mount fresh on the client and never hydrate server markup. But an
  // `ssr: true` island ships React server markup that the Preact client would
  // silently re-hydrate: a hydration mismatch nothing else catches. Refuse it at
  // build time with a coded error, naming the offending island(s) and the two
  // ways out (make it deferred, or take the whole-process-aliased worker path
  // that estate uses — react→preact aliased at build time + .renderer(
  // preactServerRenderer)). `react` builds are exempt: server and client are both
  // React, so any `ssr` value is byte-identical.
  if (options.dialect === "preact") {
    const ssrIslands = islands.filter((island) => island.ssr).map((island) => island.name);

    if (ssrIslands.length > 0) {
      throw new AssetsError(
        "ASSETS_DIALECT_SSR_MISMATCH",
        `island${ssrIslands.length > 1 ? "s" : ""} ${ssrIslands
          .map((name) => `"${name}"`)
          .join(", ")} ${ssrIslands.length > 1 ? "are" : "is"} ssr: true under the ` +
          `"preact" client dialect, but the CLI server renders React — the React ` +
          `server markup would silently mismatch the Preact client on hydration. ` +
          `Either make the island deferred (ssr: false), or build it through the ` +
          `whole-process-aliased worker path (react→preact alias + ` +
          `.renderer(preactServerRenderer), as examples/estate does) where the ` +
          `server can emit Preact markup.`,
        { dialect: options.dialect, islands: ssrIslands },
      );
    }
  }

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

  const markerPath = join(options.outDir, GENERATION_MARKER);

  // Read the prior generation's chunk names BEFORE writing — in production these
  // are the one generation to retain for in-flight documents. (Read up front so a
  // failed read never strands the build mid-write.)
  const priorGeneration = parseGeneration(await deps.read(markerPath));

  // PHASE 1 — write the new artifacts first, so a crash here leaves a servable
  // (current) build on disk rather than a half-swept empty dir.
  const entryPath = join(options.outDir, options.entryName ?? DEFAULT_ENTRY);

  await deps.write(entryPath, entryArtifact.contents);

  // Measure the gzipped size of each artifact AS IT SHIPS (gzip is the
  // network-meaningful unit; raw bytes mislead). The entry is measured by its
  // configured name, not the bundler's `entry.js`, so the report names the file
  // the browser actually fetches.
  const sizes: ArtifactSize[] = [
    {
      fileName: options.entryName ?? DEFAULT_ENTRY,
      kind: "entry",
      gzipBytes: deps.gzipSize(entryArtifact.contents),
    },
  ];

  const chunks: string[] = [];
  const newChunkNames: string[] = [];

  for (const artifact of artifacts) {
    if (artifact.kind === "entry") continue;

    newChunkNames.push(artifact.fileName);

    const chunkPath = join(options.outDir, artifact.fileName);

    await deps.write(chunkPath, artifact.contents);

    sizes.push({
      fileName: artifact.fileName,
      kind: "chunk",
      gzipBytes: deps.gzipSize(artifact.contents),
    });

    chunks.push(chunkPath);
  }

  // PHASE 2 — sweep stale chunks. Keep this build's chunks always; in production
  // also keep the immediately-prior generation (in-flight documents still fetch
  // it), so only the generation BEFORE that is removed. Development keeps only the
  // new set. Hashed names guarantee a retained chunk never shadows a new one.
  const retained = new Set<string>(newChunkNames);

  if (options.mode === "production") {
    for (const name of priorGeneration) retained.add(name);
  }

  for (const name of await deps.listOutDir(options.outDir)) {
    if (isChunkFile(name) && !retained.has(name)) {
      await deps.remove(join(options.outDir, name));
    }
  }

  // Record THIS build's chunks as the prior generation the next production build
  // will retain. Written last, after the dir is consistent.
  await deps.write(markerPath, JSON.stringify(newChunkNames));

  // Narrate what the build decided (ADR 0011): the dialect/mode, then each
  // artifact's gzipped size, with the entry's budget verdict inline. A no-op
  // `report` by default; the CLI wires `console.log`.
  narrateSizes(sizes, options, report);

  // Enforce the entry budget: a blown size promise FAILS the build (the ~10 KB
  // island bundle creeping back toward 118 KB must never ship silently). Measured
  // on the ENTRY only — the chunks are lazily fetched, so they are reported but
  // not budgeted (a per-chunk budget is future work; the entry is the cliff).
  const entrySize = sizes[0] as ArtifactSize;

  if (options.budgetBytes !== undefined && entrySize.gzipBytes > options.budgetBytes) {
    throw new AssetsError(
      "ASSETS_BUDGET_EXCEEDED",
      `client entry "${entrySize.fileName}" is ${kb(entrySize.gzipBytes)} gzip, over the ` +
        `${kb(options.budgetBytes)} budget — split a heavy island (hydrate: "visible"), drop a ` +
        `dependency, or build the preact dialect`,
      {
        fileName: entrySize.fileName,
        gzipBytes: entrySize.gzipBytes,
        budgetBytes: options.budgetBytes,
      },
    );
  }

  return { entry: entryPath, chunks, islands, sizes };
}

/** Human-readable KB to one decimal place — the size unit the report speaks. */
function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Narrate the dialect/mode and each artifact's gzip size, flagging an over-budget entry. */
function narrateSizes(
  sizes: readonly ArtifactSize[],
  options: BuildClientOptions,
  report: BuildReport,
): void {
  report(`keel: client (${options.dialect}, ${options.mode}) — ${sizes.length} artifact(s):`);

  for (const size of sizes) {
    const over =
      size.kind === "entry" &&
      options.budgetBytes !== undefined &&
      size.gzipBytes > options.budgetBytes;

    const budgetNote =
      size.kind === "entry" && options.budgetBytes !== undefined
        ? ` (budget ${kb(options.budgetBytes)}${over ? " — OVER" : ""})`
        : "";

    report(
      `  ${size.kind === "entry" ? "entry" : "chunk"} ${size.fileName}: ${kb(size.gzipBytes)} gzip${budgetNote}`,
    );
  }
}
