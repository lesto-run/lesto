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

// The two JS line terminators that are valid JSON but break a <script> body.
// Built via escape codes so no raw separator char ever appears in this source
// (a raw U+2028 in a regex literal is itself an unterminated-regex syntax error).
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * Serialize a value to JSON safe to embed inside a `<script>` element.
 *
 * `<`/`>`/`&` are escaped so the JSON can never spell `</script>` (or an HTML
 * entity) and break out of the tag. U+2028/U+2029 are *valid* JSON but are raw
 * line terminators in JavaScript source — left unescaped they truncate the
 * script and corrupt the manifest. Mirrors content-shared's `serializeJsonLd`.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(LINE_SEPARATOR, "\\u2028")
    .replaceAll(PARAGRAPH_SEPARATOR, "\\u2029");
}

/** Escape a string for safe interpolation into HTML text/element content. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Interactive controls are sized for touch: ≥44px tall with real padding, so
// adjacent nav links and form buttons clear Lighthouse's tap-target audit
// (insufficient size/spacing) instead of being thin inline text.
const STYLE = `
  :root { font-family: ui-sans-serif, system-ui, sans-serif; color: #1a1a1a; }
  body { margin: 0; }
  .site { display: flex; align-items: center; justify-content: space-between;
          padding: 1rem 2rem; border-bottom: 1px solid #eee; }
  .site__brand { font-weight: 700; text-decoration: none; color: inherit;
          display: inline-flex; align-items: center; min-height: 44px; }
  .site__nav { display: flex; align-items: center; gap: .5rem; }
  .site__nav a { display: inline-flex; align-items: center; min-height: 44px;
          padding: 0 .5rem; text-decoration: none; color: #555; }
  .account { margin-left: .5rem; }
  .hero { padding: 3rem 2rem; }
  .hero h1 { font-size: 2.25rem; margin: 0 0 .5rem; }
  .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          padding: 0 2rem 3rem; }
  .card { border: 1px solid #eee; border-radius: 12px; padding: 1.25rem; }
  .card h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
  .card__price { font-weight: 700; }
  .auth button { min-height: 44px; padding: 0 1rem; }
  .auth input { min-height: 44px; padding: 0 .5rem; }
`;

/** Render a tree into a complete, island-aware HTML document. */
export function renderDocument(registry: Registry, tree: UiNode, title: string): string {
  const page = renderPage(registry, tree);

  const body = page.element === null ? "" : renderToStaticMarkup(page.element);

  // The title is attacker-influenceable (a controller may build it from a
  // user-facing name), so it is HTML-escaped before it lands in <title>.
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
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
