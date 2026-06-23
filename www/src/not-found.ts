/**
 * The 404 page, as a self-contained HTML string.
 *
 * A static site is fully prerendered, so the only page the edge Worker ever renders
 * is this one — for a path that matches nothing. It is a plain string (no JSX, no
 * React) so the Worker bundle carries no rendering runtime: the whole point of a
 * static site is that the edge does no work. It links the same `/styles.css`
 * `@lesto/styles` compiled (served from `out/www/`), and its markup uses the same
 * Tailwind utility classes as the rest of the site — so Tailwind, scanning `src/`,
 * compiles them in and a 404 still looks like Lesto.
 */

import { DOCS_URL } from "./site";

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
    <header class="sticky top-0 z-30 border-b border-line bg-[color-mix(in_srgb,var(--bg)_78%,transparent)] backdrop-blur-[14px] backdrop-saturate-[1.8]">
      <div class="flex items-center gap-4 h-[60px] max-w-[1080px] mx-auto px-7">
        <a class="inline-flex items-center gap-[0.55rem] text-[1.02rem] font-[640] tracking-[-0.02em] text-ink" href="/">
          <span class="inline-grid place-items-center w-[23px] h-[23px] rounded-md bg-accent text-white font-bold text-[0.82rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]">L</span> Lesto
        </a>
      </div>
    </header>
    <main class="max-w-[36rem] mx-auto py-28 px-7 text-center">
      <h1 class="text-5xl mb-2 tracking-[-0.04em] font-semibold">404</h1>
      <p class="text-muted">That page isn't here. Head back to the <a href="/">home page</a>, read the <a href="${DOCS_URL}/quickstart">quickstart</a>, or browse the <a href="/blog">blog</a>.</p>
    </main>
  </body>
</html>`;
}
