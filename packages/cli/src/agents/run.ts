/**
 * `lesto generate agents` — the orchestrator that turns the scanned conventions
 * into `AGENTS.md` + `llms.txt` on disk.
 *
 * Like `runGenerate`, the core is pure and fully injected: it reads the app's
 * conventions through injected readers (routes, islands, collections), renders the
 * two artifacts from the {@link scanConventions} model (Inc 1–3), and writes them
 * through the {@link GenerateIO} seam — so every decision (what to scan, the
 * scan-before-write order, the managed-region merge, `--dry-run`, the `--check`
 * drift gate, the nothing-to-scan refusal) is tested with fakes and no disk. The
 * bin (Inc 5) supplies the real fs-backed readers + `GenerateIO`.
 *
 * Two write disciplines, matched to each artifact:
 *   - `AGENTS.md` carries a MANAGED REGION ({@link mergeManagedRegion}) so an
 *     author's hand-written guidance around it survives a regenerate.
 *   - `llms.txt` is a fully machine-generated index, rewritten wholesale.
 *
 * Modes (mutually exclusive in effect; `--check` wins if both are passed):
 *   - `--check`: write nothing; exit non-zero iff either artifact is stale (the CI
 *     freshness gate — the `routes.gen.ts` discipline).
 *   - `--dry-run`: print the plan, write nothing.
 *   - default: write only what changed, leaving a byte-identical file untouched.
 */

import { CliError } from "../errors";
import { hasFlag } from "../flags";
import type { GenerateIO } from "../generate";

import { mergeManagedRegion } from "./managed-region";
import { renderAgentsMd } from "./render-agents";
import { renderLlmsTxt } from "./render-llms";
import { scanConventions } from "./scan";
import type { AppSummary, CollectionDescriptor, RouteDescriptor } from "./types";

/** The generated artifact paths, relative to the cwd the `GenerateIO` resolves against. */
const AGENTS_PATH = "AGENTS.md";
const LLMS_PATH = "llms.txt";

/** The collection shape `@lesto/content-core`'s `getCollections` yields. */
interface RawCollection {
  readonly name: string;

  readonly entries: readonly unknown[];
}

/** The slice of the optional `@lesto/content-core` peer the collections reader needs. */
interface ContentCoreModule {
  readonly getCollections: () => readonly RawCollection[];
}

/**
 * Build the collections reader, degrading to "no collections" rather than failing
 * when `@lesto/content-core` (an optional peer) is absent OR its compiled store is
 * not built yet.
 *
 * The peer import is INJECTED (the bin passes `() => import("@lesto/content-core")`)
 * so this stays a pure, fully-tested function: a rejected import (peer absent) and a
 * throwing `getCollections` (store unbuilt) both resolve to an empty list, because a
 * project simply may not use content — that is not an error, and `--check` must stay
 * deterministic regardless of whether the store happens to be built.
 *
 * The optional `onError` sink is handed the swallowed cause so the degrade is not
 * fully silent: the bin wires it to a warning, so a genuine content-core breakage
 * leaves a trace rather than a mysteriously content-less artifact.
 */
export function createCollectionsReader(
  importContentCore: () => Promise<ContentCoreModule>,
  onError?: (error: unknown) => void,
): () => Promise<readonly CollectionDescriptor[]> {
  return async () => {
    try {
      const mod = await importContentCore();

      return mod.getCollections().map((collection) => ({
        name: collection.name,
        entryCount: collection.entries.length,
      }));
    } catch (error) {
      // Degrade to "no collections" — but surface the cause through the optional
      // sink (the bin passes a `console.warn`), so a GENUINE content-core failure
      // is not swallowed without a trace, only the expected peer-absent / store-
      // unbuilt cases pass quietly.
      onError?.(error);

      return [];
    }
  };
}

/** The injected seams `runGenerateAgents` needs — all I/O, so the core stays pure. */
export interface GenerateAgentsDeps extends GenerateIO {
  /** Yield the app's route descriptors (the bin scans `app/routes/` via `@lesto/router`). */
  readRoutes: () => Promise<readonly RouteDescriptor[]>;

  /** Yield the island module names (the bin globs `app/islands/`). */
  readIslands: () => Promise<readonly string[]>;

  /** Yield the content collections ({@link createCollectionsReader}; degrades to empty). */
  readCollections: () => Promise<readonly CollectionDescriptor[]>;

  /** The app summary stamped into the artifacts (framework identity + UI dialect). */
  summary: AppSummary;

  /** Where a line of output goes (the bin passes `console.log`). */
  out: (line: string) => void;
}

/** One artifact target: its path, the bytes it would become, what is on disk, and whether it existed. */
interface Target {
  readonly path: string;

  readonly next: string;

  readonly current: string;

  readonly existed: boolean;
}

/** Read a target's current bytes (empty string when absent), and whether it existed. */
async function readCurrent(
  io: GenerateIO,
  path: string,
): Promise<{ existed: boolean; current: string }> {
  const existed = await io.exists(path);

  return { existed, current: existed ? await io.read(path) : "" };
}

/**
 * Generate (or check) the agent artifacts. Returns the process exit code: `0` on
 * success (or a clean `--check`), `1` when `--check` finds drift.
 */
export async function runGenerateAgents(
  args: readonly string[],
  deps: GenerateAgentsDeps,
): Promise<number> {
  const check = hasFlag(args, "check");
  const dryRun = hasFlag(args, "dry-run");

  // Scan BEFORE any write: read every convention, then decide what to do.
  const [routes, islands, collections] = await Promise.all([
    deps.readRoutes(),
    deps.readIslands(),
    deps.readCollections(),
  ]);

  const artifacts = scanConventions({ summary: deps.summary, routes, islands, collections });

  // Nothing app-specific to describe — refuse rather than write a contentless file.
  if (artifacts.isEmpty) {
    throw new CliError(
      "CLI_AGENTS_NOTHING_TO_SCAN",
      "nothing to describe: the app declares no routes, islands, or content collections",
      { routes: routes.length, islands: islands.length, collections: collections.length },
    );
  }

  const agents = await readCurrent(deps, AGENTS_PATH);
  const llms = await readCurrent(deps, LLMS_PATH);

  const targets: readonly Target[] = [
    {
      path: AGENTS_PATH,
      next: mergeManagedRegion(agents.current, renderAgentsMd(artifacts)),
      current: agents.current,
      existed: agents.existed,
    },
    {
      path: LLMS_PATH,
      next: renderLlmsTxt(artifacts),
      current: llms.current,
      existed: llms.existed,
    },
  ];

  // --check: report drift, write nothing, and signal it through the exit code.
  if (check) {
    const drifted = targets.filter((target) => target.next !== target.current);

    for (const target of drifted) {
      deps.out(`drift ${target.path}`);
    }

    if (drifted.length > 0) return 1;

    deps.out("agent files are up to date");

    return 0;
  }

  // --dry-run: announce the REAL plan (a byte-identical file would be left
  // untouched, exactly as a real run reports), and write nothing.
  if (dryRun) {
    for (const target of targets) {
      const verb = target.next === target.current ? "leave" : target.existed ? "update" : "write";

      deps.out(`would ${verb} ${target.path}${verb === "leave" ? " unchanged" : ""}`);
    }

    return 0;
  }

  // Write only what changed; a byte-identical file is left untouched.
  for (const target of targets) {
    if (target.next === target.current) {
      deps.out(`unchanged ${target.path}`);

      continue;
    }

    await deps.write(target.path, target.next);

    deps.out(`${target.existed ? "updated" : "wrote"} ${target.path}`);
  }

  return 0;
}
