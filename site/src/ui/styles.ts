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

.docs-search { position: relative; }
.docs-search-input {
  width: 220px;
  max-width: 40vw;
  padding: 0.4rem 0.7rem;
  font: inherit;
  font-size: 0.9rem;
  color: var(--fg);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  outline: none;
}
.docs-search-input:focus { border-color: var(--accent); }
.docs-search-input:disabled { opacity: 0.6; }
.docs-search-results {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: min(420px, 80vw);
  max-height: 60vh;
  overflow-y: auto;
  margin: 0;
  padding: 0.35rem;
  list-style: none;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  z-index: 20;
}
.docs-search-results li { margin: 0; }
.docs-search-results a { display: block; padding: 0.5rem 0.6rem; border-radius: 6px; color: var(--fg); }
.docs-search-results a:hover { background: var(--surface); text-decoration: none; }
.docs-search-title { display: block; font-weight: 600; font-size: 0.92rem; }
.docs-search-snippet {
  display: block;
  color: var(--muted);
  font-size: 0.82rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.docs-search-empty { padding: 0.5rem 0.6rem; color: var(--muted); font-size: 0.88rem; }
@media (max-width: 600px) { .docs-search { display: none; } }

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
`;
