/**
 * The 404 page, as a self-contained HTML string.
 *
 * A docs site is fully prerendered, so the only page the edge Worker ever
 * renders is this one — for a path that matches no doc. It is a plain string (no
 * JSX, no React) so the Worker bundle carries no rendering runtime: the whole
 * point of a static site is that the edge does no work. It reuses {@link DOCS_CSS}
 * so a 404 still looks like the rest of the site.
 */

import { DOCS_CSS } from "./ui/styles";

export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Not found · Lesto</title>
    <style>${DOCS_CSS}</style>
  </head>
  <body>
    <header class="docs-header">
      <span class="brand"><a href="/">Lesto</a></span>
      <span class="tag">docs</span>
    </header>
    <main class="docs-404">
      <h1>404</h1>
      <p>That page isn't here. Try the <a href="/">documentation home</a> or the <a href="/quickstart">quickstart</a>.</p>
    </main>
  </body>
</html>`;
}
