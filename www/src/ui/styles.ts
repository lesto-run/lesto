/**
 * The marketing site's stylesheet, emitted once as an inline `<style>` at the
 * top of every page (see {@link "./layout".SiteLayout}).
 *
 * It is a plain string — no build step, no CSS-in-JS — so it is equally safe to
 * inline during the static prerender and to import into the edge Worker's 404
 * page. It is a deliberately *bolder* look than the docs site (a gradient hero,
 * large display type, card bands) while staying on the same restrained indigo
 * brand the messaging guide fixes (`#4f46e5` primary, `#3730a3` deep, system
 * sans). Rendered Markdown (blog, changelog) reuses the `.prose` typography and
 * the `@lesto/content-markdown` code-block styling appended at the bottom.
 */

import { calloutStyles, packageCommandStyles } from "@lesto/content-markdown/styles";

export const SITE_CSS = `
:root {
  --bg: #ffffff;
  --fg: #14151a;
  --muted: #5b6472;
  --border: #e6e8ee;
  --surface: #f7f8fb;
  --surface-2: #eef0f6;
  --accent: #4f46e5;
  --accent-deep: #3730a3;
  --accent-soft: #eef2ff;
  --accent-fg: #ffffff;
  --ok: #047857;
  --ok-soft: #ecfdf5;
  --warn: #b45309;
  --warn-soft: #fffbeb;
  --mute-chip: #475569;
  --mute-soft: #f1f5f9;
  --code-bg: #0d1117;
  --max: 1140px;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0d12;
    --fg: #e8eaf0;
    --muted: #9aa4b4;
    --border: #232734;
    --surface: #14161f;
    --surface-2: #1b1e2a;
    --accent: #8b8cf0;
    --accent-deep: #6366f1;
    --accent-soft: #181a2e;
    --accent-fg: #0c0d12;
    --ok: #34d399;
    --ok-soft: #0f1f1a;
    --warn: #fbbf24;
    --warn-soft: #211a0e;
    --mute-chip: #94a3b8;
    --mute-soft: #161922;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: var(--font);
  color: var(--fg);
  background: var(--bg);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

/* ── Header ──────────────────────────────────────────────────────────────── */
.site-header {
  position: sticky;
  top: 0;
  z-index: 20;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
.header-inner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  height: 60px;
  max-width: var(--max);
  margin: 0 auto;
  padding: 0 1.5rem;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 800;
  font-size: 1.15rem;
  letter-spacing: -0.02em;
  color: var(--fg);
}
.brand:hover { text-decoration: none; }
.brand-mark {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  font-weight: 800;
  font-size: 0.95rem;
}
.site-header .spacer { flex: 1; }
.site-header nav { display: flex; align-items: center; gap: 1.4rem; }
.site-header nav a { color: var(--muted); font-size: 0.92rem; font-weight: 500; }
.site-header nav a:hover { color: var(--fg); text-decoration: none; }
.site-header .nav-cta {
  padding: 0.4rem 0.9rem;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
}
.site-header .nav-cta:hover { color: #fff; background: var(--accent-deep); }
@media (max-width: 640px) { .site-header nav .hide-sm { display: none; } }

/* ── Hero ────────────────────────────────────────────────────────────────── */
.hero {
  position: relative;
  overflow: hidden;
  color: #fff;
  background:
    radial-gradient(1100px 520px at 78% -8%, rgba(199,210,254,0.30), transparent 60%),
    radial-gradient(820px 440px at 8% 8%, rgba(129,140,248,0.28), transparent 55%),
    linear-gradient(135deg, #2c2387 0%, #4f46e5 55%, #6d5cf0 100%);
}
.hero::after {
  content: "";
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px);
  background-size: 44px 44px;
  -webkit-mask-image: radial-gradient(circle at 50% 0%, #000, transparent 72%);
  mask-image: radial-gradient(circle at 50% 0%, #000, transparent 72%);
  pointer-events: none;
}
.hero-inner {
  position: relative;
  z-index: 1;
  max-width: var(--max);
  margin: 0 auto;
  padding: 5.5rem 1.5rem 6rem;
  text-align: center;
}
.hero-eyebrow {
  display: inline-block;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 0.35rem 0.8rem;
  border-radius: 999px;
  background: rgba(255,255,255,0.12);
  border: 1px solid rgba(255,255,255,0.18);
  margin-bottom: 1.5rem;
}
.hero-title {
  font-size: clamp(2.6rem, 6vw, 4.5rem);
  line-height: 1.04;
  letter-spacing: -0.035em;
  font-weight: 820;
  margin: 0 0 1.25rem;
}
.hero-title .accent { color: #c7d2fe; display: block; }
.hero-sub {
  max-width: 640px;
  margin: 0 auto 2rem;
  font-size: clamp(1.05rem, 2.4vw, 1.3rem);
  line-height: 1.55;
  color: #dfe2fb;
}
.hero-cta { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; margin-bottom: 2.25rem; }
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.98rem;
  font-weight: 650;
  padding: 0.7rem 1.3rem;
  border-radius: 10px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: transform 0.06s ease, background 0.15s ease, border-color 0.15s ease;
}
.btn:hover { text-decoration: none; transform: translateY(-1px); }
.btn-primary { background: #fff; color: var(--accent-deep); }
.btn-primary:hover { background: #eef2ff; }
.btn-ghost { background: rgba(255,255,255,0.08); color: #fff; border-color: rgba(255,255,255,0.28); }
.btn-ghost:hover { background: rgba(255,255,255,0.16); }
.hero-install {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  font-family: var(--mono);
  font-size: 0.95rem;
  padding: 0.6rem 1rem 0.6rem 1.1rem;
  border-radius: 10px;
  background: rgba(8,6,30,0.34);
  border: 1px solid rgba(255,255,255,0.16);
  color: #eef2ff;
}
.hero-install .prompt { color: #a5b4fc; user-select: none; }
.hero-install .pkg { color: #fff; }

/* ── Sections ────────────────────────────────────────────────────────────── */
.section { max-width: var(--max); margin: 0 auto; padding: 4.5rem 1.5rem; }
.section.tight { padding-top: 2.5rem; }
.section-head { max-width: 720px; margin: 0 auto 2.75rem; text-align: center; }
.eyebrow {
  display: inline-block;
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent);
  margin-bottom: 0.6rem;
}
.section-title { font-size: clamp(1.7rem, 3.6vw, 2.4rem); line-height: 1.15; letter-spacing: -0.025em; margin: 0 0 0.85rem; }
.section-lede { font-size: 1.08rem; color: var(--muted); margin: 0; }

/* ── Feature / battery grid ──────────────────────────────────────────────── */
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
@media (max-width: 880px) { .grid { grid-template-columns: 1fr 1fr; } }
@media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
.card {
  position: relative;
  padding: 1.4rem;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  transition: border-color 0.15s ease, transform 0.08s ease, box-shadow 0.15s ease;
}
.card:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); transform: translateY(-2px); box-shadow: 0 10px 30px -16px rgba(79,70,229,0.35); }
.card-title { display: flex; align-items: center; gap: 0.55rem; font-size: 1.04rem; font-weight: 700; margin: 0 0 0.4rem; letter-spacing: -0.01em; }
.card-dot { width: 9px; height: 9px; border-radius: 3px; background: var(--accent); flex: none; }
.card-desc { margin: 0; color: var(--muted); font-size: 0.94rem; line-height: 1.55; }
.card-tag {
  position: absolute;
  top: 1.1rem;
  right: 1.1rem;
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--warn);
  background: var(--warn-soft);
  border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
  border-radius: 6px;
  padding: 0.1rem 0.4rem;
}
.card-meta {
  margin: 0.85rem 0 0.55rem;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--accent);
}
.card-links { margin: 0; font-size: 0.86rem; }
.card-links a { font-weight: 500; }
.card-links .sep { color: var(--muted); }

/* ── Agent-native band ───────────────────────────────────────────────────── */
.band { background: var(--accent-soft); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.band .section { padding-top: 4.5rem; padding-bottom: 4.5rem; }
.band-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2.5rem; align-items: center; }
@media (max-width: 860px) { .band-grid { grid-template-columns: 1fr; gap: 1.75rem; } }
.band-grid h2 { font-size: clamp(1.6rem, 3.4vw, 2.2rem); line-height: 1.18; letter-spacing: -0.025em; margin: 0 0 0.85rem; }
.band-grid p { color: var(--muted); font-size: 1.02rem; margin: 0 0 0.85rem; }
.band-grid .fine { font-size: 0.86rem; }

/* ── Terminal / code ─────────────────────────────────────────────────────── */
.terminal {
  background: var(--code-bg);
  border-radius: 12px;
  border: 1px solid #20262f;
  overflow: hidden;
  box-shadow: 0 24px 60px -30px rgba(8,6,30,0.6);
}
.terminal-bar { display: flex; align-items: center; gap: 0.4rem; padding: 0.7rem 0.9rem; border-bottom: 1px solid #20262f; }
.terminal-bar i { width: 11px; height: 11px; border-radius: 50%; background: #30363d; display: inline-block; }
.terminal-bar span { margin-left: 0.5rem; color: #8b949e; font-family: var(--mono); font-size: 0.76rem; }
.terminal pre { margin: 0; padding: 1.1rem 1.2rem; overflow-x: auto; }
.terminal code { font-family: var(--mono); font-size: 0.82rem; line-height: 1.7; color: #c9d1d9; }
.terminal .c-key { color: #ff7b72; }
.terminal .c-fn { color: #d2a8ff; }
.terminal .c-str { color: #a5d6ff; }
.terminal .c-com { color: #8b949e; }
.terminal .c-ok { color: #7ee787; }

/* ── Comparison table ────────────────────────────────────────────────────── */
.compare-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 14px; }
table.compare { border-collapse: collapse; width: 100%; min-width: 640px; font-size: 0.92rem; }
table.compare th, table.compare td { padding: 0.8rem 1rem; text-align: left; border-bottom: 1px solid var(--border); }
table.compare thead th { background: var(--surface); font-size: 0.82rem; letter-spacing: 0.01em; }
table.compare thead th.lesto { color: var(--accent); }
table.compare tbody th { font-weight: 600; color: var(--fg); white-space: nowrap; }
table.compare td.lesto { font-weight: 600; background: color-mix(in srgb, var(--accent) 7%, transparent); }
table.compare tr:last-child th, table.compare tr:last-child td { border-bottom: none; }

/* ── Honest-status strip ─────────────────────────────────────────────────── */
.status-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
@media (max-width: 760px) { .status-grid { grid-template-columns: 1fr; } }
.status-col { padding: 1.3rem; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
.status-col h3 { display: flex; align-items: center; gap: 0.5rem; margin: 0 0 0.75rem; font-size: 1rem; }
.chip { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.15rem 0.5rem; border-radius: 999px; }
.chip.ok { color: var(--ok); background: var(--ok-soft); }
.chip.preview { color: var(--warn); background: var(--warn-soft); }
.chip.deferred { color: var(--mute-chip); background: var(--mute-soft); }
.status-col ul { margin: 0; padding-left: 1.05rem; color: var(--muted); font-size: 0.92rem; line-height: 1.7; }

/* ── CTA band ────────────────────────────────────────────────────────────── */
.cta-band { background: linear-gradient(135deg, var(--accent-deep), var(--accent)); color: #fff; }
.cta-band .section { text-align: center; }
.cta-band h2 { font-size: clamp(1.8rem, 4vw, 2.6rem); letter-spacing: -0.03em; margin: 0 0 0.8rem; }
.cta-band p { color: #dfe2fb; font-size: 1.1rem; margin: 0 0 1.75rem; }

/* ── Footer ──────────────────────────────────────────────────────────────── */
.site-footer { border-top: 1px solid var(--border); background: var(--surface); }
.footer-inner {
  max-width: var(--max);
  margin: 0 auto;
  padding: 2.5rem 1.5rem;
  display: flex;
  justify-content: space-between;
  gap: 1.5rem;
  flex-wrap: wrap;
}
.footer-inner .col { display: flex; flex-direction: column; gap: 0.45rem; }
.footer-inner .col strong { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 700; }
.footer-inner .col a { color: var(--fg); font-size: 0.92rem; opacity: 0.85; }
.footer-inner .col a:hover { opacity: 1; color: var(--accent); }
.footer-note { max-width: var(--max); margin: 0 auto; padding: 0 1.5rem 2.5rem; color: var(--muted); font-size: 0.84rem; }

/* ── Prose (rendered Markdown: blog + changelog) ─────────────────────────── */
.prose-shell { max-width: 720px; margin: 0 auto; padding: 3.5rem 1.5rem 4.5rem; min-width: 0; }
.prose-shell > h1 { font-size: clamp(2rem, 4vw, 2.6rem); line-height: 1.15; letter-spacing: -0.03em; margin: 0 0 0.5rem; }
.prose-lede { color: var(--muted); font-size: 1.08rem; margin: 0 0 2rem; }
.prose-back { font-size: 0.9rem; margin: 0 0 1.25rem; }
.post-meta { color: var(--muted); font-size: 0.9rem; margin: 0 0 1.75rem; }
.post-list { list-style: none; margin: 0; padding: 0; }
.post-list li { padding: 1.4rem 0; border-bottom: 1px solid var(--border); }
.post-list li:first-child { padding-top: 0; }
.post-list time { display: block; color: var(--muted); font-size: 0.82rem; }
.post-link { display: inline-block; margin: 0.2rem 0; font-size: 1.25rem; font-weight: 700; color: var(--fg); letter-spacing: -0.02em; }
.post-link:hover { color: var(--accent); text-decoration: none; }
.post-list p { margin: 0.25rem 0 0; color: var(--muted); }
.changelog-release { margin: 0 0 2.75rem; }
.changelog-release h2 { font-size: 1.5rem; margin: 2rem 0 0.5rem; letter-spacing: -0.02em; }
.changelog-release h2 time { color: var(--muted); font-size: 1rem; font-weight: 400; }

.prose h2 { font-size: 1.5rem; margin: 2.5rem 0 0.75rem; letter-spacing: -0.02em; }
.prose h3 { font-size: 1.18rem; margin: 1.75rem 0 0.5rem; }
.prose p, .prose li { font-size: 1.02rem; }
.prose a { font-weight: 500; }
.prose code {
  font-family: var(--mono);
  font-size: 0.88em;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 0.1em 0.35em;
}
.prose pre {
  background: var(--code-bg);
  border-radius: 12px;
  padding: 1rem 1.15rem;
  overflow-x: auto;
  font-size: 0.85rem;
  line-height: 1.55;
}
.prose pre code { background: none; border: none; padding: 0; font-size: inherit; }
.prose blockquote { margin: 1.25rem 0; padding: 0.25rem 1rem; border-left: 3px solid var(--accent); color: var(--muted); }
.prose table { border-collapse: collapse; width: 100%; margin: 1.25rem 0; font-size: 0.92rem; }
.prose th, .prose td { border: 1px solid var(--border); padding: 0.5rem 0.75rem; text-align: left; }
.prose th { background: var(--surface); }
.prose img { max-width: 100%; }

/* Code blocks from @lesto/content-markdown (rehype-pretty-code + Shiki). The
   framework emits the figure, the optional filename title, line markup, and a
   self-contained copy button; we only style them — scoped to .prose. */
.prose [data-rehype-pretty-code-figure] { position: relative; margin: 1.25rem 0; }
.prose [data-rehype-pretty-code-figure] pre { margin: 0; padding: 1rem 0; position: static; }
.prose [data-rehype-pretty-code-title] {
  font-family: var(--mono);
  font-size: 0.78rem;
  color: var(--muted);
  background: #161b22;
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: 12px 12px 0 0;
  padding: 0.5rem 1rem;
}
.prose [data-rehype-pretty-code-title] + pre { border-radius: 0 0 12px 12px; }
.prose [data-rehype-pretty-code-figure] code { display: grid; }
.prose [data-line] { padding: 0 1.15rem; border-left: 2px solid transparent; }
.prose [data-highlighted-line] { background: rgba(139,140,240,0.12); border-left-color: var(--accent); }
.prose .rehype-pretty-copy {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  margin: 0;
  color: #c9d1d9;
  background: rgba(110,118,129,0.22);
  border: 1px solid rgba(240,246,252,0.14);
  border-radius: 6px;
  cursor: pointer;
}
.prose .rehype-pretty-copy:hover { background: rgba(110,118,129,0.4); border-color: rgba(240,246,252,0.26); }
.prose .rehype-pretty-copy span { background-repeat: no-repeat; background-position: center; background-size: 0.95rem; }
@media (hover: none) { .prose .rehype-pretty-copy { opacity: 1; } }
.prose .lesto-pm-panel [data-rehype-pretty-code-figure] { margin: 0; }
.prose .lesto-pm-panel pre { border-radius: 0; }
.prose .lesto-pm-panel { position: relative; }

/* ── 404 ─────────────────────────────────────────────────────────────────── */
.site-404 { max-width: 620px; margin: 0 auto; padding: 6rem 1.5rem; text-align: center; }
.site-404 h1 { font-size: 3.5rem; margin: 0 0 0.5rem; letter-spacing: -0.03em; }
.site-404 p { color: var(--muted); }
` +
  // GitHub-style callout (admonition) styling, straight from
  // @lesto/content-markdown — the same plugin renders `> [!NOTE]` blocks in the
  // blog posts here.
  calloutStyles +
  // Package-manager tab styling, also from @lesto/content-markdown — the same
  // plugin emits the `package-install` tabs the enhancer wires up.
  packageCommandStyles;
