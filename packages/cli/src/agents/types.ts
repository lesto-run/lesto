/**
 * The render-ready model of a Lesto app's conventions — the single source both
 * `AGENTS.md` and `llms.txt` are built from (Inc 2/3).
 *
 * Keeping one structured model between the scan and the renderers is what lets the
 * two artifacts never drift from each other or from the app: they read the SAME
 * {@link AgentArtifacts}, so a route or collection can never appear in one and not
 * the other. The shapes here are deliberately reduced to what an agent actually
 * needs to work in the app — a route's kind + URL, an island's name, a
 * collection's name + size, the CLI surface — not the full compiler descriptors.
 */

import type { FileRouteKind } from "@lesto/router";

/** A small, deterministic summary of the app itself, for the artifact headers. */
export interface AppSummary {
  /**
   * The framework identity — always `"lesto"`. Carried (rather than hardcoded in
   * each renderer) so the one place the name lives is the scan's output.
   */
  readonly framework: "lesto";

  /** The app's UI dialect when known, else absent (the matched-pair dialect, ADR 0008). */
  readonly uiDialect?: "react" | "preact";
}

/**
 * One route the app serves, reduced to what an agent needs: its convention kind
 * and the URL pattern it answers at. A `page` is a navigable route; a `layout` /
 * `loading` / `error` / `not-found` is a directory-scoped boundary that shapes the
 * page below it (carried so the artifacts show the full routing picture).
 */
export interface RouteDescriptor {
  /** The convention kind — page/layout/loading/error/not-found (`@lesto/router`). */
  readonly kind: FileRouteKind;

  /** The compiled URL pattern, e.g. `/blog/:slug` (a boundary carries its directory's pattern). */
  readonly pattern: string;
}

/** One content collection the app declares, with how many entries it holds. */
export interface CollectionDescriptor {
  readonly name: string;

  readonly entryCount: number;
}

/** One dispatchable `lesto` CLI command — the agent-legible surface of the tool. */
export interface CliCommandDescriptor {
  /** The primary command token, e.g. `generate`. */
  readonly name: string;

  /** Alternate tokens that dispatch the same command (e.g. `["g"]`); absent when none. */
  readonly aliases?: readonly string[];

  /** A one-line description an agent (or human) reads to know what the command does. */
  readonly summary: string;
}

/**
 * The render-ready model both `AGENTS.md` and `llms.txt` are built from — the
 * output of {@link scanConventions} and the only input the renderers (Inc 2/3)
 * read. Every list is normalized to a stable order by the scan, so the rendered
 * artifacts are byte-stable (the `--check` drift guard depends on it).
 */
export interface AgentArtifacts {
  readonly summary: AppSummary;

  readonly routes: readonly RouteDescriptor[];

  /** The island module names (the interactive components), sorted. */
  readonly islands: readonly string[];

  readonly collections: readonly CollectionDescriptor[];

  readonly commands: readonly CliCommandDescriptor[];

  /**
   * True iff the app declares no routes, no islands, and no collections — i.e.
   * there is nothing app-specific to describe. The CLI surface is always present,
   * so it does not count toward emptiness. The orchestrator (Inc 4) refuses to
   * write artifacts for an empty app rather than emit a contentless file.
   */
  readonly isEmpty: boolean;
}
