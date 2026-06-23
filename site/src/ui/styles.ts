/**
 * The documentation site's stylesheet, emitted once as an inline `<style>` at
 * the top of every page (see {@link "./layout".DocsLayout}).
 *
 * It is a plain string — no build step, no CSS-in-JS — so it is equally safe to
 * inline during the static prerender and to import into the edge Worker's 404
 * page. Code blocks are styled only as containers: `@lesto/content-markdown`'s
 * Shiki pass writes per-token colors inline, so the highlighting ships in the
 * HTML and needs no theme stylesheet here.
 */

import { commandPaletteStyles } from "@lesto/content-search";
import { calloutStyles, packageCommandStyles } from "@lesto/content-markdown/styles";

export const DOCS_CSS = `
:root {
  --bg: #ffffff;
  --fg: #1c1e21;
  --muted: #6b7280;
  --border: #e5e7eb;
  --surface: #f9fafb;
  --accent: #4f46e5;
  --accent-fg: #ffffff;
  --code-bg: #0d1117;
  --max: 1240px;
  --sidebar: 248px;
  --toc: 200px;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --fg: #e6e8eb;
    --muted: #9aa4b2;
    --border: #232733;
    --surface: #161922;
    --accent: #8b8cf0;
    --accent-fg: #0f1115;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: var(--font);
  color: var(--fg);
  background: var(--bg);
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.docs-header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  height: 56px;
  padding: 0 1.25rem;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
}
.docs-header .brand { font-weight: 700; font-size: 1.05rem; letter-spacing: -0.01em; }
.docs-header .brand a { color: var(--fg); }
.docs-header .tag { color: var(--muted); font-size: 0.85rem; }
.docs-header .spacer { flex: 1; }
.docs-header nav a { color: var(--muted); font-size: 0.9rem; margin-left: 1rem; }

/* The header search is the framework's <CommandPalette> (⌘K). Its full look
   ships in @lesto/content-search's commandPaletteStyles, appended to this
   stylesheet below; only header-fit and mobile tweaks live here. */
.docs-header .lesto-cmdk-trigger:disabled { opacity: 0.6; cursor: default; }

.docs-shell {
  display: grid;
  grid-template-columns: var(--sidebar) minmax(0, 1fr) var(--toc);
  gap: 2.5rem;
  max-width: var(--max);
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
}

.docs-sidebar { position: sticky; top: 72px; align-self: start; max-height: calc(100vh - 88px); overflow-y: auto; }
.docs-sidebar .section { margin-bottom: 1.5rem; }
.docs-sidebar .section-title {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 0 0 0.5rem;
}
.docs-sidebar ul { list-style: none; margin: 0; padding: 0; }
.docs-sidebar li { margin: 0; }
.docs-sidebar a {
  display: block;
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  color: var(--fg);
  font-size: 0.92rem;
}
.docs-sidebar a:hover { background: var(--surface); text-decoration: none; }
.docs-sidebar a.active { background: var(--accent); color: var(--accent-fg); font-weight: 600; }

.docs-main { min-width: 0; }

.docs-topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
.docs-crumbs { font-size: 0.82rem; color: var(--muted); }
.docs-crumbs a { color: var(--muted); }
.docs-crumbs .current { color: var(--fg); }
.docs-actions { display: flex; align-items: center; gap: 0.4rem; }
.docs-actions a, .docs-actions button {
  font: inherit;
  font-size: 0.78rem;
  color: var(--muted);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.25rem 0.55rem;
  cursor: pointer;
  text-decoration: none;
}
.docs-actions a:hover, .docs-actions button:hover { color: var(--fg); border-color: var(--accent); text-decoration: none; }
.docs-action-copy.copied { color: var(--accent); border-color: var(--accent); }

.docs-prevnext { display: flex; justify-content: space-between; gap: 1rem; margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border); }
.docs-prevnext a { display: flex; flex-direction: column; gap: 0.2rem; padding: 0.75rem 1rem; border: 1px solid var(--border); border-radius: 10px; max-width: 48%; }
.docs-prevnext a:hover { border-color: var(--accent); text-decoration: none; }
.docs-prevnext .next { text-align: right; margin-left: auto; }
.docs-prevnext .dir { font-size: 0.78rem; color: var(--muted); }
.docs-prevnext .label { font-weight: 600; color: var(--fg); }

/* Code blocks from @lesto/content-markdown (rehype-pretty-code + Shiki). The
   framework emits the figure, the optional filename title, line markup, and a
   self-contained copy button; the docs only style them. */
.docs-article [data-rehype-pretty-code-figure] { position: relative; margin: 1.25rem 0; }
.docs-article [data-rehype-pretty-code-figure] pre { margin: 0; }

/* Filename label (a fenced block with title="lesto.app.ts") — a header tab atop the block. */
.docs-article [data-rehype-pretty-code-title] {
  font-family: var(--mono);
  font-size: 0.78rem;
  color: var(--muted);
  background: #161b22;
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: 10px 10px 0 0;
  padding: 0.5rem 1rem;
}
.docs-article [data-rehype-pretty-code-title] + pre { border-radius: 0 0 10px 10px; }

/* Line highlighting (a fenced block with {1,3-5}) — grid lines so the tint spans full width. */
.docs-article [data-rehype-pretty-code-figure] code { display: grid; }
.docs-article [data-line] { padding: 0 1.15rem; border-left: 2px solid transparent; }
.docs-article [data-highlighted-line] {
  background: rgba(139, 140, 240, 0.12);
  border-left-color: var(--accent);
}

/* The copy button is the framework's own ICON button: rehype-pretty-code's
   transformerCopyButton injects the copy/check SVGs, the 24px sizing, the
   positioning, and the hover-reveal. We add nothing else on purpose — styling it
   ourselves only fought that icon, and an earlier injected "Copy" label rendered
   ON TOP of the icon. The one gap in the injected style is touch: there is no
   hover to reveal it, so show it on coarse pointers. */
@media (hover: none) {
  .docs-article .rehype-pretty-copy { opacity: 1; }
}

/* Reconcile the package-manager tab panels with rehype-pretty-code: the
   highlighter wraps each panel's <pre> in a figure that carries its own margin
   and rounding — strip both so the code sits flush inside the tab container. */
.docs-article .lesto-pm-panel [data-rehype-pretty-code-figure] { margin: 0; }
.docs-article .lesto-pm-panel pre { border-radius: 0; }
/* The panel's own copy button is pinned to the panel, not the page figure. */
.docs-article .lesto-pm-panel { position: relative; }
.docs-article h1 { font-size: 2.1rem; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 1rem; }
.docs-article h2 { font-size: 1.45rem; margin: 2.5rem 0 0.75rem; padding-top: 0.5rem; letter-spacing: -0.01em; }
.docs-article h3 { font-size: 1.15rem; margin: 1.75rem 0 0.5rem; }
.docs-article p, .docs-article li { font-size: 1rem; }
.docs-article code {
  font-family: var(--mono);
  font-size: 0.88em;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.1em 0.35em;
}
.docs-article pre {
  background: var(--code-bg);
  border-radius: 10px;
  padding: 1rem 1.15rem;
  overflow-x: auto;
  font-size: 0.85rem;
  line-height: 1.55;
}
.docs-article pre code { background: none; border: none; padding: 0; font-size: inherit; }
.docs-article blockquote {
  margin: 1.25rem 0;
  padding: 0.25rem 1rem;
  border-left: 3px solid var(--accent);
  color: var(--muted);
}
.docs-article table { border-collapse: collapse; width: 100%; margin: 1.25rem 0; font-size: 0.92rem; }
.docs-article th, .docs-article td { border: 1px solid var(--border); padding: 0.5rem 0.75rem; text-align: left; }
.docs-article th { background: var(--surface); }
.docs-article img { max-width: 100%; }

.docs-toc { position: sticky; top: 72px; align-self: start; font-size: 0.85rem; }
.docs-toc .toc-title { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 0.5rem; }
.docs-toc ul { list-style: none; margin: 0; padding: 0; }
.docs-toc a { display: block; padding: 0.2rem 0; color: var(--muted); }
.docs-toc a:hover { color: var(--fg); text-decoration: none; }
.docs-toc .depth-3 { padding-left: 0.85rem; }

.docs-footer { max-width: var(--max); margin: 0 auto; padding: 1.5rem 1.25rem 3rem; color: var(--muted); font-size: 0.85rem; border-top: 1px solid var(--border); }

/* Blog + changelog: a centered, single-column prose frame (no docs sidebar). */
.prose-shell { max-width: 720px; margin: 0 auto; padding: 2rem 1.25rem 4rem; min-width: 0; }
.prose-shell > h1 { font-size: 2.1rem; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 0.5rem; }
.prose-lede { color: var(--muted); font-size: 1.05rem; margin: 0 0 2rem; }
.prose-back { font-size: 0.9rem; margin: 0 0 1rem; }
.post-list { list-style: none; margin: 0; padding: 0; }
.post-list li { padding: 1.25rem 0; border-bottom: 1px solid var(--border); }
.post-list time { display: block; color: var(--muted); font-size: 0.82rem; }
.post-link { display: inline-block; margin: 0.15rem 0; font-size: 1.2rem; font-weight: 650; color: var(--fg); letter-spacing: -0.01em; }
.post-link:hover { color: var(--accent); text-decoration: none; }
.post-list p { margin: 0.25rem 0 0; color: var(--muted); }
.post-meta { color: var(--muted); font-size: 0.88rem; margin: 0 0 1.5rem; }
.changelog-release { margin: 0 0 2.5rem; }
.changelog-release h2 { font-size: 1.45rem; margin: 2rem 0 0.5rem; letter-spacing: -0.01em; }
.changelog-release h2 time { color: var(--muted); font-size: 1rem; font-weight: 400; }

.docs-404 { max-width: 640px; margin: 0 auto; padding: 6rem 1.25rem; text-align: center; }
.docs-404 h1 { font-size: 3rem; margin: 0 0 0.5rem; }

@media (max-width: 1024px) {
  .docs-shell { grid-template-columns: var(--sidebar) minmax(0, 1fr); }
  .docs-toc { display: none; }
}
@media (max-width: 720px) {
  .docs-shell { grid-template-columns: minmax(0, 1fr); gap: 1.5rem; }
  .docs-sidebar { position: static; max-height: none; border-bottom: 1px solid var(--border); padding-bottom: 1rem; }
}
` +
  // The ⌘K command palette's own stylesheet, dogfooded straight from the
  // framework so the docs look is the framework's look — not a fork of it.
  commandPaletteStyles +
  // GitHub-style callout (admonition) styling, likewise straight from
  // @lesto/content-markdown — the same plugin renders `> [!NOTE]` blocks here.
  calloutStyles +
  // Package-manager tab styling, also from @lesto/content-markdown — the same
  // plugin emits the `package-install` tabs the enhancer wires up.
  packageCommandStyles +
  `
/* On touch viewports the keyboard hint is meaningless and the label is noise. */
@media (max-width: 600px) {
  .docs-header .lesto-cmdk-trigger-label { display: none; }
  .lesto-cmdk-kbd { display: none; }
}
`;
