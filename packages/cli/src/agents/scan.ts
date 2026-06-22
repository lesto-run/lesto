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
 * pattern then kind, islands and collections by name, commands by name. So the
 * rendered artifacts are byte-stable no matter what order the readers happened to
 * yield their facts in — which is exactly what the `--check` drift guard (Inc 2/4)
 * relies on to tell a real convention change from incidental reader reordering.
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
export function scanConventions(input: ScanInput): AgentArtifacts {
  const routes = input.routes.toSorted(
    (a, b) => a.pattern.localeCompare(b.pattern) || a.kind.localeCompare(b.kind),
  );

  const islands = input.islands.toSorted((a, b) => a.localeCompare(b));

  const collections = input.collections.toSorted((a, b) => a.name.localeCompare(b.name));

  const commands = (input.commands ?? CLI_COMMANDS).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );

  const isEmpty = routes.length === 0 && islands.length === 0 && collections.length === 0;

  return { summary: input.summary, routes, islands, collections, commands, isEmpty };
}
