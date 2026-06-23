/**
 * The command palette's quick-picks — the pages (and the one repo link) `⌘K`
 * lands on before you type a query.
 *
 * Pages are listed by slug alone: {@link CommandPalette} reads each title and
 * snippet from the prerendered search index, so this list can never drift from
 * the real page titles, and a page renamed or removed from the docs simply drops
 * out of the list on its own. The repo link is the one entry that isn't a doc
 * page, so it carries its own title. Keep the count at or under the palette's
 * result `limit` (8) so none are trimmed; `popular.test.ts` guards that every
 * internal slug here still resolves to a real page.
 */

import type { CommandPaletteItem } from "@lesto/content-search/react";

export const POPULAR_PAGES: CommandPaletteItem[] = [
  { slug: "/quickstart" },
  { slug: "/why-lesto" },
  { slug: "/concepts" },
  { slug: "/guides/routing" },
  { slug: "/batteries/data" },
  { slug: "/deploy/cloudflare" },
  {
    id: "github",
    slug: "https://github.com/lesto-run/lesto",
    title: "Star Lesto on GitHub",
    snippet: "Browse the source and releases",
  },
];
