/**
 * The site's one zone: the marketing site, rendered statically at the root.
 *
 * `pages` is a function, not a fixed list — the editorial routes (blog posts) are
 * derived from the content collection at build time. `lesto build` / `build.ts`
 * reads this default export, asks the app to render each route, and writes the
 * results under `out/www/`. Add a Markdown file under `content/blog/` and it
 * shows up here automatically; the hand-built routes (`/`, `/use-cases`) are
 * listed explicitly.
 */

import { defineSites } from "@lesto/sites";

import { loadBlog } from "./src/content";

export default defineSites([
  {
    name: "www",
    render: "static",
    basePath: "/",
    pages: async () => {
      const posts = await loadBlog();
      return [
        "/",
        "/use-cases",
        "/blog",
        ...posts.map((post) => post.route),
        "/changelog",
      ];
    },
  },
]);
