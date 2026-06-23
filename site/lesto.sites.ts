/**
 * The site's one zone: the docs, rendered statically at the root.
 *
 * `pages` is a function, not a fixed list — so the set of routes to prerender is
 * derived from the content collection at build time. `lesto build` / `build.ts`
 * reads this default export, asks the app to render each route, and writes the
 * results under `out/docs/`. Add a Markdown file under `content/docs/` and it
 * shows up here automatically; there is no route list to keep in sync.
 */

import { defineSites } from "@lesto/sites";

import { loadDocs } from "./src/content";

export default defineSites([
  {
    name: "docs",
    render: "static",
    basePath: "/",
    // Every doc route, derived from the content collection at build time — add a
    // Markdown file under content/docs/ and it prerenders here. (The blog and
    // changelog moved to the marketing site, `www/`.)
    pages: async () => {
      const docs = await loadDocs();
      return docs.map((doc) => doc.route);
    },
  },
]);
