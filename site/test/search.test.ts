/**
 * The search index ships keywords that actually find the right page.
 *
 * Builds the index from the real docs (the same `buildSearchIndex` the build
 * runs), then drives `@lesto/content-search`'s `keywordSearch` over it — the
 * exact call the browser island makes — to prove representative queries rank the
 * intended page first. This is the substance of search; the island is the same
 * call wrapped in an input.
 */

import { keywordSearch } from "@lesto/content-search";
import { describe, expect, it } from "vitest";

import { loadDocs } from "../src/content";
import { buildSearchIndex } from "../src/search-index";

const built = "2026-06-20T00:00:00.000Z";

describe("buildSearchIndex", () => {
  it("indexes every doc with keywords and a routable slug", async () => {
    const docs = await loadDocs();
    const index = buildSearchIndex(docs, built);

    expect(index.version).toBe(0);
    expect(index.entries.length).toBe(docs.length);
    for (const entry of index.entries) {
      expect(entry.slug.startsWith("/")).toBe(true); // links straight to the page
      expect(entry.keywords.length).toBeGreaterThan(0);
      expect(entry.snippet.length).toBeGreaterThan(0);
    }
  });
});

describe("keywordSearch over the built index", () => {
  it("ranks the intended page first for representative queries", async () => {
    const index = buildSearchIndex(await loadDocs(), built);

    const cases: ReadonlyArray<readonly [string, string]> = [
      ["deploy cloudflare", "/deploy/cloudflare"],
      ["background queue jobs", "/batteries/queue"],
      ["two factor authentication", "/batteries/auth"],
      ["feature flags", "/batteries/flags"],
      ["database query", "/batteries/data"],
    ];

    for (const [query, expected] of cases) {
      const results = keywordSearch(query, index, { limit: 5 });
      expect(results[0]?.slug, `query: ${query}`).toBe(expected);
    }
  });

  it("returns nothing for an empty query", async () => {
    const index = buildSearchIndex(await loadDocs(), built);

    expect(keywordSearch("", index, { limit: 5 })).toEqual([]);
  });
});
