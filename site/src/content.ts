/**
 * Load the documentation content at build time.
 *
 * This is the seam between `@lesto/content-*` and the rest of the app. It runs
 * the content pipeline once — globbing `content/docs/`, validating frontmatter,
 * rendering Markdown to HTML with a heading outline — and reshapes each entry
 * into the small {@link DocEntry} the routes and UI consume. Everything here
 * executes under Node at build time (during `lesto dev`, `build.ts`, and the
 * static prerender); no content engine, database, or filesystem read reaches
 * the Cloudflare edge, which only ever serves the prerendered HTML.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runPipeline } from "@lesto/content-core/build";

import config, { type DocFrontmatter } from "../lesto.content";

/** One heading in a doc's body — the raw material for the on-page table of contents. */
export interface DocHeading {
  readonly depth: number;
  readonly slug: string;
  readonly text: string;
}

/** A single documentation page, rendered and ready to route. */
export interface DocEntry {
  /** The URL the page is served at, derived from its path under `content/docs/`. */
  readonly route: string;
  readonly title: string;
  readonly description: string | undefined;
  readonly section: string;
  readonly order: number;
  /** The sanitized HTML body produced by `@lesto/content-markdown`. */
  readonly html: string;
  /** The raw Markdown body — the source for the search index's keywords. */
  readonly text: string;
  /** The heading outline used to build the right-rail table of contents. */
  readonly headings: readonly DocHeading[];
}

/** A sidebar group: a section title and the pages within it, in order. */
export interface NavSection {
  readonly title: string;
  readonly items: readonly { readonly route: string; readonly title: string }[];
}

/** The repo root of this site — the cwd the content pipeline globs from. */
const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Sections render in this order; any section not named here sorts after, alphabetically. */
const SECTION_ORDER = ["Getting started", "Guides", "Batteries", "Deploy", "Reference"] as const;

/** A content entry's frontmatter and rendered body, the slice this module reads. */
interface RawEntry extends DocFrontmatter {
  readonly content: string;
  readonly file: { readonly pathSegments: readonly string[] };
  readonly rendered?: { readonly html: string; readonly headings: readonly DocHeading[] };
}

/** Map a route's path segments to its URL: `[]` → `/`, `["a","b"]` → `/a/b`. */
function routeOf(pathSegments: readonly string[]): string {
  return pathSegments.length === 0 ? "/" : `/${pathSegments.join("/")}`;
}

/** Reshape a pipeline entry into the flat {@link DocEntry} the app routes on. */
function toDocEntry(entry: RawEntry): DocEntry {
  return {
    route: routeOf(entry.file.pathSegments),
    title: entry.title,
    description: entry.description,
    section: entry.section,
    order: entry.order,
    html: entry.rendered?.html ?? "",
    text: entry.content,
    headings: entry.rendered?.headings ?? [],
  };
}

/** Order two docs: by ascending `order`, then by title for a stable tiebreak. */
function byOrder(a: DocEntry, b: DocEntry): number {
  return a.order - b.order || a.title.localeCompare(b.title);
}

/**
 * Run the content pipeline and return every doc as a {@link DocEntry}, sorted.
 *
 * Called from the app factory (to register a route per page), from the sites
 * config (to enumerate what the static build prerenders), and from the tests.
 */
export async function loadDocs(): Promise<DocEntry[]> {
  const result = await runPipeline({ cwd: SITE_ROOT, config, skipWrite: true });
  const entries = result.entries as unknown as RawEntry[];
  return entries.map(toDocEntry).toSorted(byOrder);
}

/** Rank a section by its position in {@link SECTION_ORDER} (unnamed sections sort last). */
function sectionRank(title: string): number {
  const index = SECTION_ORDER.indexOf(title as (typeof SECTION_ORDER)[number]);
  return index === -1 ? SECTION_ORDER.length : index;
}

/**
 * Group sorted docs into sidebar sections.
 *
 * Sections appear in {@link SECTION_ORDER} (then alphabetically); within each,
 * pages keep the `order`/title sort `loadDocs` already applied.
 */
export function buildNav(docs: readonly DocEntry[]): NavSection[] {
  const groups = new Map<string, { route: string; title: string }[]>();

  for (const doc of docs) {
    const items = groups.get(doc.section) ?? [];
    items.push({ route: doc.route, title: doc.title });
    groups.set(doc.section, items);
  }

  return [...groups.entries()]
    .map(([title, items]): NavSection => ({ title, items }))
    .toSorted((a, b) => sectionRank(a.title) - sectionRank(b.title) || a.title.localeCompare(b.title));
}
