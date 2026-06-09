/**
 * Wrap a UI tree into a full HTML document.
 *
 * `renderPage` gives us the SSR'd body plus the island manifest. We emit the
 * body, then serialize the manifest into a `<script type="application/json">`
 * and point at the client bundle — exactly what `hydrateIslands` reads on load.
 * A page with no islands ships an empty manifest and is pure static HTML.
 */

import { renderToStaticMarkup } from "react-dom/server";

import { renderPage } from "@keel/ui";
import type { Registry, UiNode } from "@keel/ui";

/** Escape `<` so the manifest JSON can never break out of its script tag. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

const STYLE = `
  :root { font-family: ui-sans-serif, system-ui, sans-serif; color: #1a1a1a; }
  body { margin: 0; }
  .site { display: flex; align-items: center; justify-content: space-between;
          padding: 1rem 2rem; border-bottom: 1px solid #eee; }
  .site__brand { font-weight: 700; text-decoration: none; color: inherit; }
  .site__nav a { margin-left: 1.25rem; text-decoration: none; color: #555; }
  .account { margin-left: 1.25rem; }
  .hero { padding: 3rem 2rem; }
  .hero h1 { font-size: 2.25rem; margin: 0 0 .5rem; }
  .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          padding: 0 2rem 3rem; }
  .card { border: 1px solid #eee; border-radius: 12px; padding: 1.25rem; }
  .card__price { font-weight: 700; }
`;

/** Render a tree into a complete, island-aware HTML document. */
export function renderDocument(registry: Registry, tree: UiNode, title: string): string {
  const page = renderPage(registry, tree);

  const body = page.element === null ? "" : renderToStaticMarkup(page.element);

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${title}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    body,
    `<script id="keel-islands" type="application/json">${safeJson(page.islands)}</script>`,
    '<script type="module" src="/client.js"></script>',
    "</body>",
    "</html>",
  ].join("\n");
}
