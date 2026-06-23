/**
 * The 404 page, as a self-contained HTML string.
 *
 * A static site is fully prerendered, so the only page the edge Worker ever
 * renders is this one — for a path that matches nothing. It is a plain string
 * (no JSX, no React) so the Worker bundle carries no rendering runtime: the
 * whole point of a static site is that the edge does no work. It reuses
 * {@link SITE_CSS} so a 404 still looks like the rest of the site.
 */

import { DOCS_URL } from "./site";
import { SITE_CSS } from "./ui/styles";

export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Not found · Lesto</title>
    <style>${SITE_CSS}</style>
  </head>
  <body>
    <header class="site-header">
      <div class="header-inner">
        <a class="brand" href="/"><span class="brand-mark">L</span> Lesto</a>
      </div>
    </header>
    <main class="site-404">
      <h1>404</h1>
      <p>That page isn't here. Head back to the <a href="/">home page</a>, read the <a href="${DOCS_URL}/quickstart">quickstart</a>, or browse the <a href="/blog">blog</a>.</p>
    </main>
  </body>
</html>`;
}
