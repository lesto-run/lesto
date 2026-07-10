/**
 * The documentation content collection.
 *
 * Every page on the docs site is a Markdown file under `content/docs/`. This
 * config is the single source of truth for how those files are read, validated,
 * and rendered: `@lesto/content-core` globs the directory, parses each file's
 * YAML frontmatter against {@link docFrontmatter}, and — because `render` is set
 * — runs `@lesto/content-markdown` over the body to produce sanitized HTML, an
 * extracted heading outline (the on-page table of contents), and Shiki syntax
 * highlighting for fenced code blocks. All of that happens once, at build time;
 * the site ships as static HTML with no content engine on the edge.
 *
 * `src/content.ts` feeds this config to `runPipeline`; nothing reads a
 * `docks.config.ts` from disk, so the collection lives here under the Lesto name.
 */

import { defineCollection, defineConfig } from "@lesto/content-core";
import { z } from "zod";

/** The frontmatter every doc declares — drives the title, ordering, and nav grouping. */
export const docFrontmatter = z.object({
  /** The page's `<title>` and page heading. */
  title: z.string(),
  /** A shorter sidebar label; falls back to `title` when omitted. Set it when the
   *  title is a full descriptive phrase that would wrap or crowd the nav rail. */
  navLabel: z.string().optional(),
  /** A one-line summary used for the page's meta description and header subtitle. */
  description: z.string().optional(),
  /** The sidebar group this page belongs to (e.g. "Getting started"). */
  section: z.string(),
  /** Sort order within the section; lower comes first. */
  order: z.number().default(0),
});

/** The shape of a validated doc's frontmatter, inferred from the schema. */
export type DocFrontmatter = z.infer<typeof docFrontmatter>;

const docs = defineCollection({
  name: "docs",
  directory: "content/docs",
  include: "**/*.md",
  schema: docFrontmatter,
  // Render Markdown → HTML at build time, with syntax-highlighted code blocks
  // and an extracted heading outline (consumed as the on-page TOC).
  render: { syntaxHighlighting: true },
});

// The blog and changelog collections moved to the marketing site (`www/`), which
// now owns every editorial surface; docs.lesto.run keeps the reference docs.

export default defineConfig({ collections: [docs] });
