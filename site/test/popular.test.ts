/**
 * The command palette's quick-picks point at pages that actually exist.
 *
 * The palette self-heals — it drops a quick-pick whose slug is no longer in the
 * index rather than linking to a dead route — so a renamed page would silently
 * shrink the list instead of failing. This test makes that loud: every internal
 * slug in {@link POPULAR_PAGES} must resolve to a real doc, off-index entries
 * (the repo link) must carry their own title, and the list must fit the palette's
 * result limit so none are trimmed.
 */

import { describe, expect, it } from "vitest";

import { loadDocs } from "../src/content";
import { POPULAR_PAGES } from "../src/popular";
import { buildSearchIndex } from "../src/search-index";

const PALETTE_LIMIT = 8;

describe("POPULAR_PAGES", () => {
  it("fits the palette's result limit", () => {
    expect(POPULAR_PAGES.length).toBeLessThanOrEqual(PALETTE_LIMIT);
  });

  it("points every internal page at a real, indexed doc", async () => {
    const index = buildSearchIndex(await loadDocs(), "2026-06-22T00:00:00.000Z");
    const slugs = new Set(index.entries.map((entry) => entry.slug));

    for (const item of POPULAR_PAGES) {
      if (item.slug.startsWith("/")) {
        // An internal page: its title comes from the index, so it must be there.
        expect(slugs.has(item.slug), `popular slug not in docs: ${item.slug}`).toBe(true);
      } else {
        // An off-index action (e.g. the repo link) has no index entry to borrow
        // a title from, so it must carry its own.
        expect(item.title, `off-index quick-pick needs a title: ${item.slug}`).toBeTruthy();
      }
    }
  });
});
