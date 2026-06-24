/**
 * The 404 page, as a self-contained HTML string.
 *
 * A docs site is fully prerendered, so the only page the edge Worker ever renders
 * is this one — for a path that matches no doc. It is a plain string (no JSX, no
 * React) so the Worker bundle carries no rendering runtime: the whole point of a
 * static site is that the edge does no work. It links the same `/styles.css`
 * `@lesto/styles` compiled (served from `out/docs/`), and its markup uses the same
 * Tailwind utility classes as the rest of the site — so Tailwind, scanning `src/`,
 * compiles them in and a 404 still looks like the docs.
 */

export function renderNotFound(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Not found · Lesto</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header class="docs-header sticky top-0 z-10 flex items-center gap-3 h-[56px] px-5 border-b border-border">
      <span class="font-bold text-[1.05rem] tracking-[-0.01em]"><a class="text-fg" href="/">Lesto</a></span>
      <span class="text-muted text-[0.85rem]">docs</span>
    </header>
    <main class="max-w-[640px] mx-auto py-24 px-5 text-center">
      <h1 class="text-5xl mb-2">404</h1>
      <p>That page isn't here. Try the <a href="/">documentation home</a> or the <a href="/quickstart">quickstart</a>.</p>
    </main>
  </body>
</html>`;
}
