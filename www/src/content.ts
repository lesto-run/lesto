/**
 * Load the marketing site's editorial content at build time.
 *
 * This is the seam between `@lesto/content-*` and the rest of the app. It runs
 * the content pipeline once — globbing `content/blog/` and `content/changelog/`,
 * validating frontmatter, rendering Markdown to HTML — and reshapes each entry
 * into the small types the routes and UI consume. Everything here executes under
 * Node at build time (during `lesto dev`, `build.ts`, and the static prerender);
 * no content engine, database, or filesystem read reaches the Cloudflare edge,
 * which only ever serves the prerendered HTML.
 *
 * The landing page and the use-cases showcase are hand-built React, not Markdown,
 * so they have no loader here.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runPipeline } from "@lesto/content-core/build";

import config, { type BlogFrontmatter, type ChangelogFrontmatter } from "../lesto.content";

/** The repo root of this site — the cwd the content pipeline globs from. */
const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The fields every pipeline entry carries, regardless of collection. */
interface RawBase {
  /** The collection the entry came from — `blog` | `changelog`. */
  readonly collection: string;
  readonly content: string;
  readonly file: { readonly pathSegments: readonly string[] };
  readonly rendered?: { readonly html: string };
}

type RawBlog = RawBase & BlogFrontmatter;
type RawChangelog = RawBase & ChangelogFrontmatter;

// ── Blog ──────────────────────────────────────────────────────────────────

/** One blog post, rendered and ready to route at `/blog/<slug>`. */
export interface BlogPost {
  /** The URL the post is served at, e.g. `/blog/the-queue-runs-on-your-database`. */
  readonly route: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string | undefined;
  /** ISO `YYYY-MM-DD`; the index sorts on this, newest first. */
  readonly date: string;
  readonly author: string | undefined;
  /** The sanitized HTML body produced by `@lesto/content-markdown`. */
  readonly html: string;
}

/** Sort newest-first by date, then by title for a stable tiebreak. */
function byDateDesc(a: { date: string; title: string }, b: { date: string; title: string }): number {
  return b.date.localeCompare(a.date) || a.title.localeCompare(b.title);
}

/** Reshape a pipeline entry into a {@link BlogPost}. */
function toBlogPost(entry: RawBlog): BlogPost {
  const slug = entry.file.pathSegments.join("/");
  return {
    route: `/blog/${slug}`,
    slug,
    title: entry.title,
    description: entry.description,
    date: entry.date,
    author: entry.author,
    html: entry.rendered?.html ?? "",
  };
}

/** Run the pipeline and return every blog post, newest first. */
export async function loadBlog(): Promise<BlogPost[]> {
  const result = await runPipeline({ cwd: SITE_ROOT, config, skipWrite: true });
  const entries = result.entries as unknown as RawBase[];
  return entries
    .filter((entry): entry is RawBlog => entry.collection === "blog")
    .map(toBlogPost)
    .toSorted(byDateDesc);
}

// ── Changelog ─────────────────────────────────────────────────────────────

/** One changelog release, rendered for the single `/changelog` page. */
export interface ChangelogRelease {
  readonly version: string;
  /** ISO `YYYY-MM-DD`; releases render newest first. */
  readonly date: string;
  readonly title: string | undefined;
  /** The sanitized HTML body produced by `@lesto/content-markdown`. */
  readonly html: string;
}

/** Reshape a pipeline entry into a {@link ChangelogRelease}. */
function toChangelogRelease(entry: RawChangelog): ChangelogRelease {
  return {
    version: entry.version,
    date: entry.date,
    title: entry.title,
    html: entry.rendered?.html ?? "",
  };
}

/** Run the pipeline and return every changelog release, newest first. */
export async function loadChangelog(): Promise<ChangelogRelease[]> {
  const result = await runPipeline({ cwd: SITE_ROOT, config, skipWrite: true });
  const entries = result.entries as unknown as RawBase[];
  return entries
    .filter((entry): entry is RawChangelog => entry.collection === "changelog")
    .map(toChangelogRelease)
    .toSorted((a, b) => b.date.localeCompare(a.date) || b.version.localeCompare(a.version));
}
