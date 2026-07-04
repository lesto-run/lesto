/**
 * Bundle an app's island hydration client — the framework-owned client pipeline
 * (ADR 0011, Seam 2), absorbing what estate hand-wrote in `build-client.ts`.
 *
 * The orchestration is pure logic over injected seams (discover islands, write
 * the entry, sweep stale artifacts), so it is tested without a bundler or a disk;
 * the real `Bun.build` + `node:fs` wiring lives in `bun.ts` (the default deps,
 * which the coverage gate excludes exactly as it excludes a `bin`).
 *
 * The order is the contract: discover the islands → synthesize the entry from
 * their declarations → bundle → write the entry + this build's artifacts → sweep
 * the *previous* build's stale artifacts (chunks AND emitted assets). The sweep
 * runs only after a successful build (a failed rebuild leaves the last good output
 * intact) and only after the new artifacts are on disk (write-then-sweep, never the
 * reverse — see {@link buildClient}).
 */

import { join } from "node:path";

import { isChunkFile } from "./chunks";
import { AssetsError } from "./errors";
import { verifyPublicEnvDefine } from "./public-env";
import type { PublicEnvDefine } from "./public-env";
import { RUM_MODULE } from "./rum-client";
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
   * own `lesto build` on a blown budget. Omitted = measure-and-report only, never
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

  /**
   * The PUBLIC-env inject map (`@lesto/env`'s `clientDefineMap`): a bundler
   * `define`/replace that inlines a `PUBLIC_*`-only schema's validated values into
   * island code, so an island can read public config (an API base, an analytics key)
   * in the browser where there is no `process.env`.
   *
   * Verified before it reaches the bundler ({@link verifyPublicEnvDefine}): a key that
   * names anything other than the public bag global or a `PUBLIC_*` read is a server
   * leak and FAILS the build with `ASSETS_SERVER_ENV_LEAK`. Omitted = inject nothing.
   */
  readonly publicEnvDefine?: PublicEnvDefine;
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

  /**
   * The verified PUBLIC-env `define`/replace map (see
   * {@link BuildClientOptions.publicEnvDefine}) — merged into the bundler's `define`
   * so `PUBLIC_*` config is inlined into island code. Always present (an empty `{}`
   * when nothing is injected), already leak-checked, so the bundler seam applies it
   * verbatim with no further validation.
   */
  readonly publicEnvDefine: PublicEnvDefine;
}

/** The injected seams `buildClient` orchestrates over — real implementations in `bun.ts`. */
export interface BuildClientDeps {
  /** Discover island modules under the dir, classified eager/lazy by their declared hydrate strategy. */
  listIslands(islandsDir: string): Promise<readonly IslandFile[]>;

  /** Compile the synthesized entry; returns the entry + chunk artifacts. Throws on a failed build. */
  bundle(request: BundleRequest): Promise<readonly BundleArtifact[]>;

  /**
   * Resolve a framework runtime import (a bare specifier the synthesized entry `import`s, e.g. the
   * RUM subpath) from the APP ROOT, exactly as the bundler will — returning the resolved path, or
   * `undefined` when it does not resolve. Drives the build-time preflight that turns a missing
   * framework dependency into an actionable error at the source instead of an opaque bundler
   * "failed to resolve" deep in the build. Real impl: `Bun.resolveSync(specifier, appRoot)` in
   * `bun.ts` (the same resolver the preact alias uses), so the preflight sees the app's REAL
   * `node_modules` layout in production while a fake answers offline in tests.
   */
  resolveClientImport(specifier: string): string | undefined;

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
 * The generation marker: each build records the non-entry artifact file names it
 * wrote (chunks AND emitted assets — an island's imported CSS/binary), so the NEXT
 * build knows the pipeline's own provenance. Hidden so it is never mistaken for an
 * asset and never served.
 *
 * It carries TWO generations, not one. `current` is this build's artifacts — the one
 * generation a production rebuild retains for in-flight documents. `prior` is the
 * generation BEFORE that (the names `current` itself superseded), kept only so a
 * production rebuild can SWEEP it: once `current` becomes the retained prior
 * generation, the generation behind it must be removed, but its names would
 * otherwise be forgotten the moment the marker was overwritten. A content-hashed JS
 * chunk has a structural fallback net ({@link isChunkFile}); an emitted ASSET
 * (`asset-<hash>.css`, a `logo.png`) does NOT — its extension is arbitrary — so the
 * marker is the only record of which non-chunk files this pipeline owns. Tracking the
 * one-generation-back names gives assets the SAME exactly-one-prior-generation
 * guarantee chunks already get, instead of letting them accumulate forever.
 */
const GENERATION_MARKER = ".lesto-chunks.json";

/**
 * The pipeline's own provenance read from {@link GENERATION_MARKER}: the previous
 * build's artifacts (`current`, the one generation a prod rebuild retains) and the
 * generation before that (`prior`, kept only to be swept).
 */
interface Generation {
  /** The previous build's non-entry artifact names — the retainable prior generation. */
  readonly current: readonly string[];

  /** The generation before `current` — pipeline files now stale and sweepable. */
  readonly prior: readonly string[];
}

/** Keep only the string members of an unknown value that should be a name array. */
function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * Parse the generation marker; tolerate a missing/corrupt marker (treated as no
 * provenance). Back-compatible with the original BARE-ARRAY marker that recorded a
 * single generation's chunk names: that form parses as `current` with no `prior`,
 * so a pre-upgrade on-disk marker keeps working (its chunks still sweep via
 * {@link isChunkFile}; any assets it left simply sweep one generation later — bounded,
 * never unbounded).
 */
function parseGeneration(contents: string | undefined): Generation {
  if (contents === undefined) return { current: [], prior: [] };

  try {
    const parsed: unknown = JSON.parse(contents);

    // The legacy form: a bare array of the previous build's chunk names.
    if (Array.isArray(parsed)) return { current: stringArray(parsed), prior: [] };

    // The current form: `{ current, prior }`. A non-object (or missing fields)
    // degrades to empty arrays rather than throwing.
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;

      return { current: stringArray(record["current"]), prior: stringArray(record["prior"]) };
    }

    return { current: [], prior: [] };
  } catch {
    return { current: [], prior: [] };
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
 * The sweep policy is mode-aware. Development sweeps every prior artifact not in the
 * new build (a clean dir, no CDN, no in-flight concern). Production keeps exactly ONE
 * previous generation — the artifacts the LAST production build wrote, recorded in a
 * {@link GENERATION_MARKER} — so an in-flight old document still resolves its chunks,
 * while a third generation does not accumulate unbounded.
 *
 * The sweep covers ASSETS, not just JS chunks. An island that imports a non-JS asset
 * (`import "./x.css"`, `import logo from "./logo.png?url"`) makes the bundler emit an
 * `asset-<hash>.<ext>` file; it is written + recorded in the marker like any chunk,
 * but its extension is arbitrary, so {@link isChunkFile} (`.js`-only) never matched it
 * and it accumulated across builds forever. The sweep is therefore driven by the
 * marker's PROVENANCE (the files this pipeline previously wrote), with `isChunkFile`
 * retained only as the fallback net for orphaned JS chunks with NO marker provenance
 * (a pre-marker build, a deleted/corrupt marker, a dialect switch). See
 * {@link GENERATION_MARKER} for why the marker tracks two generations.
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

  // Verify the PUBLIC-env inject map BEFORE bundling — a server var that would leak
  // into island code fails the build loud + early (ASSETS_SERVER_ENV_LEAK), never
  // silently inlined. An empty `{}` (the common case) is the verified no-op.
  const publicEnvDefine = verifyPublicEnvDefine(options.publicEnvDefine);

  // In development the synthesized entry installs the page-refresh hook AND the
  // ADR-0011 hydration-error overlay (`beacon.dev`): a saved `app/routes/*` file swaps
  // the page in place instead of full-reloading, and a hydration error paints the
  // overlay instead of POSTing to the beacon. This `buildClient` is the Bun dev
  // FALLBACK path (an app that opted out of the island-dev Vite server) — the Vite dev
  // server sets the same flag via its own entry — so wiring it here is what lights the
  // page swap up on the Bun path too. Production passes `dev: false`, so the prod
  // bundle ships neither the hook nor the overlay swap.
  const entrySource = synthesizeEntry(islands, { dev: options.mode === "development" });

  // Preflight the framework runtime import the synthesized entry UNCONDITIONALLY carries: browser
  // RUM is on by default (`RumConfig` has no opt-out), so `synthesizeEntry` always emits
  // `import … from "@lesto/observability/rum"` — even for an empty islands dir. That makes
  // `@lesto/observability` a hard, unstated dependency of EVERY app with a client entry. The
  // scaffold declares it, but a hand-written app need not, and under an isolated per-app
  // `node_modules` layout the gap surfaces only as an opaque bundler "failed to resolve
  // @lesto/observability/rum" deep in the build (it has bitten three times). Resolve it from the app
  // root — exactly as the bundler will — and refuse HERE, loud + actionable (ADR 0011
  // loud-when-wrong), rather than letting the bundle fail cryptically. Making the RUM injection
  // conditional on the dep was rejected as fail-open: it would silently drop the UI→API→DB trace the
  // framework's pitch rests on. (L-a457e604.)
  if (deps.resolveClientImport(RUM_MODULE) === undefined) {
    throw new AssetsError(
      "ASSETS_MISSING_RUM_DEPENDENCY",
      `the client entry imports "${RUM_MODULE}" — browser RUM (the UI→API→DB trace's browser half) ` +
        `is on by default — but "@lesto/observability" does not resolve from the app root. Add it to ` +
        `your dependencies (e.g. \`bun add @lesto/observability\`).`,
      { module: RUM_MODULE, dependency: "@lesto/observability" },
    );
  }

  const artifacts = await deps.bundle({
    entrySource,
    mode: options.mode,
    dialect: options.dialect,
    publicEnvDefine,
  });

  const entryArtifact = artifacts.find((artifact) => artifact.kind === "entry");

  if (entryArtifact === undefined) {
    throw new AssetsError("ASSETS_NO_ENTRY", "the bundler produced no entry-point artifact", {
      islandsDir: options.islandsDir,
    });
  }

  const markerPath = join(options.outDir, GENERATION_MARKER);

  // Read the pipeline's own provenance BEFORE writing — `current` is the one
  // generation to retain in production (for in-flight documents); `prior` is the
  // generation behind it, kept only so it can be swept now. (Read up front so a
  // failed read never strands the build mid-write.)
  const generation = parseGeneration(await deps.read(markerPath));
  const priorGeneration = generation.current;

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

  // PHASE 2 — sweep stale artifacts (chunks AND emitted assets). Keep this build's
  // artifacts always; in production also keep the immediately-prior generation
  // (in-flight documents still fetch it), so only the generation BEFORE that is
  // removed. Development keeps only the new set. Hashed names guarantee a retained
  // artifact never shadows a new one.
  const retained = new Set<string>(newChunkNames);

  if (options.mode === "production") {
    for (const name of priorGeneration) retained.add(name);
  }

  // A file is OURS to sweep when it is not retained AND the pipeline is known to
  // have written it — i.e. it carries marker provenance (it is in the prior
  // generation `current`, or the generation behind it, `prior`), OR it matches the
  // structural fallback net for orphaned JS chunks with no provenance at all
  // ({@link isChunkFile}). The marker only ever lists NON-ENTRY artifacts, so a
  // provenance-driven removal can never touch the entry, the marker itself, or the
  // prerendered HTML — each absent from both name lists and not a `chunk-*.js`.
  //   - Development: `retained` is the new set only, so a prior-generation asset
  //     (in `current`, not retained) is swept here — closing the dev asset leak.
  //   - Production: `current` is retained, so its assets survive; the generation
  //     behind it (`prior`) is NOT retained and IS provenance, so its assets are
  //     swept — the exactly-one-prior-generation rule, now for assets too.
  const provenance = new Set<string>([...generation.current, ...generation.prior]);

  for (const name of await deps.listOutDir(options.outDir)) {
    if (!retained.has(name) && (provenance.has(name) || isChunkFile(name))) {
      await deps.remove(join(options.outDir, name));
    }
  }

  // Record THIS build's artifacts as `current` (the generation the next production
  // build retains) and the generation it just superseded as `prior` (so the build
  // after next can sweep it even after this marker is overwritten — the only record
  // of an extensionless asset's provenance). Written last, after the dir is
  // consistent.
  const nextMarker: Generation = { current: newChunkNames, prior: priorGeneration };

  await deps.write(markerPath, JSON.stringify(nextMarker));

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
  report(`lesto: client (${options.dialect}, ${options.mode}) — ${sizes.length} artifact(s):`);

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
