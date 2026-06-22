/**
 * The convention scan — pure facts in, one render-ready {@link AgentArtifacts} out.
 *
 * This is the single source both `AGENTS.md` and `llms.txt` render from (Inc 2/3),
 * so the two artifacts can never disagree. It is PURE: no `fs`, no `process`, no
 * network. Every real-world fact — the discovered routes, the island module names,
 * the content collections, the app summary — is passed IN by the orchestrator
 * (Inc 4), which owns the injected readers. That keeps every decision here
 * (normalization, stable ordering, the empty-app determination) unit-testable with
 * plain fixtures and no disk, the same discipline `lesto generate` already follows.
 *
 * Ordering is made deterministic HERE, never assumed of the caller: routes sort by
 * pattern then kind, islands and collections by name, commands by name. Every sort
 * compares by CODE POINT ({@link byCodePoint}), never `localeCompare` — a host's
 * `LANG`/ICU collation (and even Node-vs-Bun) must never change the generated
 * bytes, since the `--check` drift guard (Inc 2/4) regenerates under one runtime
 * and the build under another. So the rendered artifacts are byte-stable no matter
 * what order the readers yielded their facts in, or which runtime ran the scan —
 * which is exactly what `--check` relies on to tell a real convention change from
 * incidental reordering or a collation difference.
 */

import { CLI_COMMANDS } from "./commands";
import type {
  AgentArtifacts,
  AppSummary,
  CliCommandDescriptor,
  CollectionDescriptor,
  RouteDescriptor,
} from "./types";

/** The already-real facts the scan turns into the render-ready model. */
export interface ScanInput {
  /** A small summary of the app itself (framework identity, UI dialect when known). */
  readonly summary: AppSummary;

  /** The discovered routes (pages + boundaries), in any order. */
  readonly routes: readonly RouteDescriptor[];

  /** The island module names (interactive components), in any order. */
  readonly islands: readonly string[];

  /**
   * The content collections, in any order. The orchestrator passes an empty list
   * when content-core is absent or its store is unbuilt, so the scan never has to
   * know whether content is installed — it stays pure over whatever it receives.
   */
  readonly collections: readonly CollectionDescriptor[];

  /**
   * The CLI command catalogue. Defaults to {@link CLI_COMMANDS} (the authority);
   * a test passes a fixture list to keep its assertions independent of the real
   * catalogue.
   */
  readonly commands?: readonly CliCommandDescriptor[];
}

/**
 * Normalize the app's real conventions into the stable, render-ready
 * {@link AgentArtifacts}.
 *
 * Pure and total: it sorts via `toSorted` (so the caller's arrays are never
 * mutated), orders every list deterministically, and flags the empty app — one
 * with no routes, no islands, and no collections — so the orchestrator can refuse
 * to write a contentless artifact. The CLI surface is always present and so never
 * counts toward emptiness.
 */
/**
 * Compare two strings by CODE POINT — a total order (`-1`/`0`/`1`) independent of
 * locale, `LANG`, and the host's ICU build (and of Node vs Bun). The codebase
 * already learned this for the route manifest (`@lesto/web` `byCodePoint`,
 * `file-routes.ts`): a freshness guard that regenerates under one runtime and
 * builds under another must produce identical bytes, which `localeCompare` cannot
 * guarantee. The `0` case is real here — two routes can share a `pattern` (a
 * `page` and its `layout`), so the comparison must report equality and let the
 * caller fall through to the kind tie-break.
 */
function byCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;

  return 0;
}

export function scanConventions(input: ScanInput): AgentArtifacts {
  const routes = input.routes.toSorted(
    (a, b) => byCodePoint(a.pattern, b.pattern) || byCodePoint(a.kind, b.kind),
  );

  const islands = input.islands.toSorted(byCodePoint);

  const collections = input.collections.toSorted((a, b) => byCodePoint(a.name, b.name));

  const commands = (input.commands ?? CLI_COMMANDS).toSorted((a, b) => byCodePoint(a.name, b.name));

  const isEmpty = routes.length === 0 && islands.length === 0 && collections.length === 0;

  return { summary: input.summary, routes, islands, collections, commands, isEmpty };
}
