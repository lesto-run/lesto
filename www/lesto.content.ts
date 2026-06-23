/**
 * The marketing site's content collections — the blog and the changelog.
 *
 * Both are Markdown files (under `content/blog/` and `content/changelog/`) that
 * moved here from the docs site so that lesto.run owns every editorial surface;
 * docs.lesto.run keeps the reference docs. `@lesto/content-core` globs each
 * directory, validates YAML frontmatter against the schemas below, and — because
 * `render` is set — runs `@lesto/content-markdown` over the body to produce
 * sanitized HTML and Shiki syntax highlighting. All of that happens once, at
 * build time; the site ships as static HTML with no content engine on the edge.
 *
 * The landing page and the use-cases showcase are hand-built React, not Markdown,
 * so they are not collections here — they are registered directly in `src/app.ts`.
 */

import { defineCollection, defineConfig } from "@lesto/content-core";
import { z } from "zod";

/** A blog post's frontmatter — drives the post list, the post page, and its meta. */
export const blogFrontmatter = z.object({
  /** The post title (its `<title>` and the visible heading source). */
  title: z.string(),
  /** A one-line summary — the list blurb and the meta description. */
  description: z.string().optional(),
  /** Publish date, ISO `YYYY-MM-DD`; the post list sorts on it, newest first. */
  date: z.string(),
  /** Optional byline. */
  author: z.string().optional(),
});

/** The shape of a validated blog post's frontmatter. */
export type BlogFrontmatter = z.infer<typeof blogFrontmatter>;

const blog = defineCollection({
  name: "blog",
  directory: "content/blog",
  include: "**/*.md",
  schema: blogFrontmatter,
  render: { syntaxHighlighting: true },
});

/** A changelog entry's frontmatter — one file per release, listed newest first. */
export const changelogFrontmatter = z.object({
  /** The release version (e.g. `0.1.0`) or `Unreleased`. */
  version: z.string(),
  /** Release date, ISO `YYYY-MM-DD` (the date the changes landed / are targeted). */
  date: z.string(),
  /** Optional one-line headline for the release. */
  title: z.string().optional(),
});

/** The shape of a validated changelog entry's frontmatter. */
export type ChangelogFrontmatter = z.infer<typeof changelogFrontmatter>;

const changelog = defineCollection({
  name: "changelog",
  directory: "content/changelog",
  include: "**/*.md",
  schema: changelogFrontmatter,
  render: { syntaxHighlighting: true },
});

export default defineConfig({ collections: [blog, changelog] });
