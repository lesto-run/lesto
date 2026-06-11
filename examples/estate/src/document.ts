/**
 * Wrap a UI tree into a full HTML document.
 *
 * `renderPage` gives us the SSR'd body plus the island manifest. We emit the
 * body, serialize the manifest through `@keel/ui`'s `serializeManifest` (the one
 * audited script-context-safe seam — never a hand-rolled stringify), point at
 * the client bundle, and — for any island that binds a data source (ADR 0010) —
 * emit the parse-time primer that kicks its fetch parallel with `client.js`. A
 * page with no islands ships an empty manifest and no primer: pure static HTML.
 *
 * Head placement (ADR 0011 Seam 1, fixed 2026-06-11): the primer and the
 * `type="module"` client tag live in `<head>`, not at end-of-body. The primer's
 * whole purpose is to start the data fetch at parse time; at end-of-body it
 * would only start after the entire document had parsed. A `type="module"`
 * script is deferred by spec — it downloads immediately and executes after the
 * parse — so the `#keel-islands` manifest (kept at end-of-body: inert payload
 * the runtime reads post-parse, and keeping it after the content keeps
 * first-paint bytes first) is always present when the runtime runs.
 *
 * The body goes through `@keel/ui`'s `renderPageMarkup`, never a direct
 * `react-dom/server` call: that seam is what keeps an `ssr: true` island's
 * hydration markers intact (`renderToString` when any island is ssr, marker-free
 * `renderToStaticMarkup` otherwise — render.tsx owns the rule) and what lets a
 * caller swap the server dialect (`renderer`) to Preact's when the client bundle
 * is Preact (ADR 0008). Bypassing it with a hard `renderToStaticMarkup` — as
 * this file once did — would silently strip the markers from the first
 * `ssr: true` island and break its hydration, in any dialect.
 */

import { dataPrimerScript, renderPage, renderPageMarkup, serializeManifest } from "@keel/ui";
import type { Registry, ServerRenderer, UiNode } from "@keel/ui";

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

/**
 * Render a tree into a complete, island-aware HTML document.
 *
 * `renderer` picks the server dialect — default React; pass `@keel/ui`'s
 * `preactServerRenderer` when (and only when) the module graph is aliased to
 * `preact/compat`, as the Worker bundle is (see `wrangler.jsonc`). The dialect
 * must match the element factory that built the tree: an unaliased node process
 * builds React elements, which only the React renderer can render.
 */
export function renderDocument(
  registry: Registry,
  tree: UiNode,
  title: string,
  description?: string,
  renderer?: ServerRenderer,
): string {
  const page = renderPage(registry, tree);

  const body = renderPageMarkup(page, renderer);

  const primer = dataPrimerScript(page.islands);

  // The title and description are attacker-influenceable (a controller may build
  // them from a user-facing name), so they are HTML-escaped before they land in
  // their respective tags. A page without a description omits the meta entirely
  // rather than emit an empty one — crawlers read a missing tag, not a blank one.
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    ...(description === undefined
      ? []
      : [`<meta name="description" content="${escapeHtml(description)}" />`]),
    `<style>${STYLE}</style>`,
    // The data primer: a plain (non-deferred) inline script in <head> that starts
    // each bound source's fetch the instant the parser reaches it — at parse time,
    // before the deferred module below executes — so per-user data lands parallel
    // with client.js, never in a doc→js→fetch chain (ADR 0010). Empty (and so
    // omitted) for a page whose islands bind no data.
    ...(primer === "" ? [] : [`<script>${primer}</script>`]),
    // The client module in <head>: a type="module" script is deferred by spec,
    // so it downloads now and runs after the full parse — when the end-of-body
    // manifest is already in the DOM for the runtime to read.
    '<script type="module" src="/client.js"></script>',
    "</head>",
    "<body>",
    body,
    `<script id="keel-islands" type="application/json">${serializeManifest(page.islands)}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
