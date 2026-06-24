/**
 * Build the client search index from the loaded docs.
 *
 * The site search is `@lesto/content-search`'s keyword tier (`Tier0Index`): no
 * embeddings, no model, no server — just per-doc keywords extracted at build
 * time and matched against the query in the browser. We build that index here
 * with the SAME `extractKeywords` the runtime `keywordSearch` uses, so the index
 * terms and the query terms are tokenized identically. the `lesto.build.ts` hook writes the
 * result to `out/docs/search-index.json`; the search island fetches it on mount.
 */

import { extractKeywords } from "@lesto/content-search";
import type { Tier0Entry, Tier0Index } from "@lesto/content-search";

import type { DocEntry } from "./content";

/** The shipped index — a `@lesto/content-search` keyword index (`Tier0Index`). */
export type SearchIndex = Tier0Index;

const SNIPPET_MAX = 160;
const KEYWORDS_PER_DOC = 80;

/** A short display snippet: the frontmatter description, else the opening prose. */
function snippetFor(doc: DocEntry): string {
  if (doc.description !== undefined) return doc.description;

  const prose = doc.text
    .replace(/^#.*$/m, "") // drop the leading H1
    .replace(/[`*_#>[\]]/g, "") // strip the common Markdown markers
    .replace(/\s+/g, " ")
    .trim();

  return prose.length > SNIPPET_MAX ? `${prose.slice(0, SNIPPET_MAX).trimEnd()}…` : prose;
}

/** Turn one doc into a `Tier0Entry` — keywords from title + body, slug = its route. */
function toEntry(doc: DocEntry): Tier0Entry {
  return {
    id: doc.route,
    slug: doc.route, // we route on the full path, so the result links straight to it
    collection: "docs",
    title: doc.title,
    snippet: snippetFor(doc),
    keywords: extractKeywords(`${doc.title}\n${doc.text}`, KEYWORDS_PER_DOC),
  };
}

/** Turn the docs into a keyword search index. `builtAt` is stamped by the caller. */
export function buildSearchIndex(docs: readonly DocEntry[], builtAt: string): Tier0Index {
  return { version: 0, builtAt, entries: docs.map(toEntry) };
}
