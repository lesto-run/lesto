/**
 * The marketing site's stylesheet, emitted once as an inline `<style>` at the
 * top of every page (see {@link "./layout".SiteLayout}).
 *
 * Design language: **refined & premium** — a near-white canvas, one restrained
 * indigo accent, impeccable typography, generous whitespace, hairline borders,
 * and quiet motion. No loud full-bleed gradients, no heavy cards, no faux-OS
 * terminal chrome. The signature visual is a custom "one substrate" diagram, not
 * stock imagery. Rendered Markdown (blog, changelog) reuses the `.prose`
 * typography and the `@lesto/content-markdown` code styling appended at the end.
 */

import { calloutStyles, packageCommandStyles } from "@lesto/content-markdown/styles";

export const SITE_CSS = `
:root {
  --bg: #ffffff;
  --bg-soft: #fafafa;
  --panel: #ffffff;
  --ink: #0a0a0b;
  --ink-2: #3f3f46;
  --muted: #71717a;
  --faint: #a1a1aa;
  --line: #ececef;
  --line-2: #e4e4e7;
  --accent: #4f46e5;
  --accent-ink: #4338ca;
  --accent-soft: #f5f3ff;
  --accent-line: #e0e0fb;
  --ok: #15803d;
  --warn: #b45309;
  --code-bg: #0c0c0f;
  --code-fg: #e4e4e7;
  --max: 1080px;
  --r: 12px;
  --font: ui-sans-serif, system-ui, -apple-system, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, "JetBrains Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #09090b;
    --bg-soft: #0d0d10;
    --panel: #111114;
    --ink: #fafafa;
    --ink-2: #d4d4d8;
    --muted: #a1a1aa;
    --faint: #71717a;
    --line: #1d1d22;
    --line-2: #26262c;
    --accent: #8b8cf0;
    --accent-ink: #a5a6f6;
    --accent-soft: #14141f;
    --accent-line: #26263a;
    --ok: #4ade80;
    --warn: #fbbf24;
    --code-bg: #0c0c0f;
    --code-fg: #e4e4e7;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: var(--font);
  color: var(--ink);
  background: var(--bg);
  line-height: 1.6;
  letter-spacing: -0.011em;
  font-feature-settings: "cv05", "ss01";
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--accent-ink); text-decoration: none; }
a:hover { color: var(--accent); }
::selection { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.wrap { max-width: var(--max); margin: 0 auto; padding: 0 1.75rem; }

/* ── Header ──────────────────────────────────────────────────────────────── */
.site-header {
  position: sticky;
  top: 0;
  z-index: 30;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  backdrop-filter: saturate(180%) blur(14px);
  border-bottom: 1px solid var(--line);
}
.header-inner { display: flex; align-items: center; gap: 1rem; height: 60px; max-width: var(--max); margin: 0 auto; padding: 0 1.75rem; }
.brand { display: inline-flex; align-items: center; gap: 0.55rem; font-weight: 640; font-size: 1.02rem; letter-spacing: -0.02em; color: var(--ink); }
.brand:hover { color: var(--ink); }
.brand-mark { display: inline-grid; place-items: center; width: 23px; height: 23px; border-radius: 6px; background: var(--accent); color: #fff; font-weight: 700; font-size: 0.82rem; box-shadow: inset 0 1px 0 rgba(255,255,255,0.22); }
.site-header .spacer { flex: 1; }
.site-header nav { display: flex; align-items: center; gap: 1.6rem; }
.site-header nav a { color: var(--muted); font-size: 0.9rem; font-weight: 480; letter-spacing: -0.01em; }
.site-header nav a:hover { color: var(--ink); }
.site-header .nav-cta { color: var(--ink); font-weight: 540; }
.site-header .nav-cta:hover { color: var(--accent); }
@media (max-width: 640px) { .site-header nav .hide-sm { display: none; } }

/* ── Hero ────────────────────────────────────────────────────────────────── */
.hero { position: relative; overflow: hidden; border-bottom: 1px solid var(--line); }
.hero::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    radial-gradient(60% 50% at 50% -8%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%);
  pointer-events: none;
}
.hero::after {
  content: "";
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(var(--line) 1px, transparent 1px),
    linear-gradient(90deg, var(--line) 1px, transparent 1px);
  background-size: 56px 56px;
  -webkit-mask-image: radial-gradient(70% 55% at 50% 0%, #000 0%, transparent 75%);
  mask-image: radial-gradient(70% 55% at 50% 0%, #000 0%, transparent 75%);
  opacity: 0.5;
  pointer-events: none;
}
.hero-inner { position: relative; z-index: 1; max-width: var(--max); margin: 0 auto; padding: 6rem 1.75rem 3rem; text-align: center; }
.hero-eyebrow {
  display: inline-flex; align-items: center; gap: 0.5rem;
  font-size: 0.8rem; font-weight: 500; color: var(--muted);
  padding: 0.3rem 0.7rem 0.3rem 0.5rem; margin-bottom: 1.9rem;
  border: 1px solid var(--line-2); border-radius: 999px; background: var(--panel);
}
.hero-eyebrow:hover { color: var(--ink); border-color: var(--accent-line); }
.hero-eyebrow .tag { font-weight: 600; color: var(--accent-ink); background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 999px; padding: 0.05rem 0.45rem; font-size: 0.72rem; letter-spacing: 0.01em; }
.hero-eyebrow .arw { color: var(--faint); }
.hero h1 { font-size: clamp(2.7rem, 6.2vw, 4.3rem); line-height: 1.02; letter-spacing: -0.04em; font-weight: 600; margin: 0 0 1.4rem; color: var(--ink); }
.hero h1 .dim { color: var(--muted); }
.hero-sub { max-width: 33rem; margin: 0 auto 2.3rem; font-size: clamp(1.05rem, 2.1vw, 1.22rem); line-height: 1.5; color: var(--ink-2); letter-spacing: -0.013em; }
.hero-cta { display: flex; gap: 0.8rem; justify-content: center; align-items: center; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; gap: 0.45rem; font: inherit; font-size: 0.95rem; font-weight: 540; letter-spacing: -0.01em; padding: 0.6rem 1.2rem; border-radius: 999px; border: 1px solid transparent; cursor: pointer; transition: background 0.16s ease, border-color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease; }
.btn:hover { text-decoration: none; }
.btn-primary { background: var(--accent); color: #fff; box-shadow: 0 1px 2px rgba(20,18,60,0.18), inset 0 1px 0 rgba(255,255,255,0.16); }
.btn-primary:hover { background: var(--accent-ink); color: #fff; transform: translateY(-1px); box-shadow: 0 6px 18px -8px color-mix(in srgb, var(--accent) 70%, transparent); }
.btn-ghost { background: var(--panel); color: var(--ink); border-color: var(--line-2); }
.btn-ghost:hover { color: var(--ink); border-color: var(--faint); transform: translateY(-1px); }
.btn .ic { width: 15px; height: 15px; }
.hero-cmd { display: inline-flex; align-items: center; gap: 0.6rem; margin-top: 1.7rem; font-family: var(--mono); font-size: 0.86rem; color: var(--ink-2); }
.hero-cmd code { background: var(--bg-soft); border: 1px solid var(--line-2); border-radius: 7px; padding: 0.4rem 0.7rem; color: var(--ink); }
.hero-cmd .pr { color: var(--faint); }

/* The signature: the custom one-substrate diagram, framed quietly. */
.hero-figure { position: relative; z-index: 1; max-width: 720px; margin: 2.25rem auto 0; padding: 0 1.75rem 1rem; }
.diagram { width: 100%; height: auto; display: block; }
.diagram .d-chip { fill: var(--panel); stroke: var(--line-2); }
.diagram .d-chip-tx { fill: var(--ink-2); font-family: var(--font); font-weight: 500; }
.diagram .d-wire { stroke: var(--accent-line); fill: none; }
.diagram .d-node { fill: var(--accent); }
.diagram .d-base { fill: var(--accent-soft); stroke: var(--accent-line); }
.diagram .d-base-tx { fill: var(--accent-ink); font-family: var(--font); font-weight: 600; }
.diagram .d-base-sub { fill: var(--muted); font-family: var(--mono); }
.diagram .d-cap { fill: var(--faint); font-family: var(--font); font-weight: 500; letter-spacing: 0.08em; }

/* ── Proof strip ─────────────────────────────────────────────────────────── */
.proof { border-bottom: 1px solid var(--line); background: var(--bg-soft); }
.proof-row { max-width: var(--max); margin: 0 auto; padding: 1.05rem 1.75rem; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 0.85rem 1.5rem; }
.proof-item { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.83rem; color: var(--muted); letter-spacing: -0.01em; white-space: nowrap; }
.proof-item a { color: var(--muted); }
.proof-item a:hover { color: var(--ink); }
.proof-item .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: 0.7; }
.proof-sep { width: 1px; height: 13px; background: var(--line-2); }
@media (max-width: 680px) { .proof-sep { display: none; } }

/* ── Sections ────────────────────────────────────────────────────────────── */
.section { max-width: var(--max); margin: 0 auto; padding: 6.5rem 1.75rem; }
.section + .section { padding-top: 0; }
.section-head { max-width: 40rem; margin: 0 0 3rem; }
.section-head.center { margin-left: auto; margin-right: auto; text-align: center; }
.eyebrow { display: block; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.02em; color: var(--accent-ink); margin-bottom: 0.9rem; }
.section-title { font-size: clamp(1.7rem, 3.4vw, 2.3rem); line-height: 1.12; letter-spacing: -0.032em; font-weight: 600; margin: 0 0 0.9rem; color: var(--ink); }
.section-lede { font-size: 1.08rem; line-height: 1.55; color: var(--muted); margin: 0; letter-spacing: -0.012em; }

/* ── Battery grid (refined: hairline cells, no heavy cards) ──────────────── */
.bgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
@media (max-width: 820px) { .bgrid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 540px) { .bgrid { grid-template-columns: 1fr; } }
.cell { position: relative; padding: 1.5rem 1.55rem; background: var(--panel); transition: background 0.22s ease; }
.cell:hover { background: radial-gradient(95% 80% at 50% -12%, color-mix(in srgb, var(--accent) 9%, var(--panel)), var(--panel) 68%); }
.cell-h { display: flex; align-items: center; gap: 0.6rem; margin: 0 0 0.5rem; font-size: 0.98rem; font-weight: 600; letter-spacing: -0.015em; color: var(--ink); }
.cell-ic { width: 17px; height: 17px; color: var(--accent); flex: none; }
.cell-d { margin: 0; font-size: 0.9rem; line-height: 1.55; color: var(--muted); letter-spacing: -0.008em; }
.cell-tag { position: absolute; top: 1.5rem; right: 1.5rem; font-size: 0.64rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--warn); }

/* ── Use-case cards (refined bordered grid; tolerates odd counts) ───────── */
.ucgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
@media (max-width: 820px) { .ucgrid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 540px) { .ucgrid { grid-template-columns: 1fr; } }
.uccard { display: flex; flex-direction: column; padding: 1.5rem 1.55rem; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel); transition: border-color 0.18s ease, transform 0.14s ease, background 0.22s ease, box-shadow 0.18s ease; }
.uccard:hover { border-color: var(--accent-line); transform: translateY(-3px); background: radial-gradient(110% 90% at 50% -10%, color-mix(in srgb, var(--accent) 7%, var(--panel)), var(--panel) 70%); box-shadow: 0 18px 40px -24px color-mix(in srgb, var(--accent) 45%, transparent); }
.uccard .cell-h { margin-bottom: 0.55rem; }
.uccard .cell-d { flex: 1; }
.uc-meta { margin: 0.9rem 0 0.55rem; font-size: 0.74rem; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: var(--accent-ink); }
.uc-links { margin: 0; font-size: 0.86rem; letter-spacing: -0.01em; }
.uc-links a { color: var(--ink-2); font-weight: 500; } .uc-links a:hover { color: var(--accent); }
.uc-links .sep { color: var(--faint); }

/* ── Split rows (agent-native, app-shape) ───────────────────────────────── */
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 3.5rem; align-items: center; }
.split.rev .split-media { order: -1; }
@media (max-width: 860px) { .split { grid-template-columns: 1fr; gap: 2rem; } .split.rev .split-media { order: 0; } }
.split h2 { font-size: clamp(1.55rem, 3vw, 2.05rem); line-height: 1.15; letter-spacing: -0.03em; font-weight: 600; margin: 0 0 1rem; }
.split p { color: var(--muted); font-size: 1.02rem; line-height: 1.6; margin: 0 0 1rem; letter-spacing: -0.01em; }
.split .fine { font-size: 0.86rem; color: var(--faint); }
.split .more { font-weight: 540; font-size: 0.95rem; }

/* ── Refined code / transcript panel (no faux-OS chrome) ────────────────── */
.panel { border: 1px solid #23232b; border-radius: var(--r); background: var(--code-bg); overflow: hidden; box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 26px 64px -34px rgba(10,8,40,0.5); }
@media (prefers-color-scheme: dark) { .panel { box-shadow: 0 1px 0 rgba(255,255,255,0.05) inset, 0 26px 64px -34px rgba(0,0,0,0.7); } }
/* Syntax-style window chrome: muted dots on the left, then a filename tab. */
.panel-bar { display: flex; align-items: center; gap: 0.8rem; padding: 0.7rem 0.95rem 0; border-bottom: 1px solid #1b1b22; background: linear-gradient(#131319, var(--code-bg)); }
.panel-bar .dots { display: inline-flex; gap: 6px; padding-bottom: 0.7rem; }
.panel-bar .dots i { width: 11px; height: 11px; border-radius: 50%; background: #34343e; }
.panel-tab { font-family: var(--mono); font-size: 0.74rem; color: #c7c7d2; background: var(--code-bg); border: 1px solid #23232b; border-bottom: 1px solid var(--code-bg); border-radius: 7px 7px 0 0; padding: 0.35rem 0.75rem; margin-bottom: -1px; }
.panel-tab .accent { color: #93c5fd; }
.panel pre { margin: 0; padding: 1rem 1.15rem; overflow-x: auto; }
.panel code { font-family: var(--mono); font-size: 0.8rem; line-height: 1.8; color: var(--code-fg); }
/* Line-numbered code (the Syntax look) — each line is a .cl block. */
.panel.numbered code { counter-reset: ln; }
.panel.numbered .cl { display: block; position: relative; padding-left: 2.7rem; min-height: 1.44em; }
.panel.numbered .cl::before { counter-increment: ln; content: counter(ln); position: absolute; left: 0; width: 1.7rem; text-align: right; color: #45454f; -webkit-user-select: none; user-select: none; }
.panel .c-com { color: #5d5d68; font-style: italic; }
.panel .c-key { color: #c4b5fd; }
.panel .c-fn  { color: #7dd3fc; }
.panel .c-str { color: #6ee7b7; }
.panel .c-num { color: #fdba74; }
.panel .c-ok  { color: #6ee7a8; }
.panel .c-mut { color: #7a7a86; }

/* ── Comparison (minimal) ───────────────────────────────────────────────── */
.cmp-wrap { border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
table.cmp { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
table.cmp th, table.cmp td { padding: 0.85rem 1.1rem; text-align: left; border-bottom: 1px solid var(--line); letter-spacing: -0.01em; }
table.cmp thead th { font-weight: 540; color: var(--muted); font-size: 0.82rem; background: var(--bg-soft); }
table.cmp thead th.lesto { color: var(--accent-ink); }
table.cmp tbody th { font-weight: 500; color: var(--ink-2); white-space: nowrap; }
table.cmp td { color: var(--muted); }
table.cmp td.lesto { color: var(--ink); font-weight: 540; background: color-mix(in srgb, var(--accent) 4%, transparent); }
table.cmp tr:last-child th, table.cmp tr:last-child td { border-bottom: none; }
.cmp-scroll { overflow-x: auto; } table.cmp { min-width: 640px; }

/* ── Honest-status (refined columns) ────────────────────────────────────── */
.status-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
@media (max-width: 760px) { .status-grid { grid-template-columns: 1fr; } }
.status-col { padding: 1.6rem 1.55rem; background: var(--panel); }
.status-col h3 { display: flex; align-items: center; gap: 0.5rem; margin: 0 0 1rem; font-size: 0.82rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.status-col h3 .pip { width: 7px; height: 7px; border-radius: 50%; }
.pip.ok { background: var(--ok); } .pip.preview { background: var(--warn); } .pip.deferred { background: var(--faint); }
.status-col ul { list-style: none; margin: 0; padding: 0; }
.status-col li { padding: 0.34rem 0; font-size: 0.9rem; color: var(--ink-2); letter-spacing: -0.01em; border-top: 1px solid var(--line); }
.status-col li:first-child { border-top: none; }
.status-col li span { color: var(--faint); }

/* ── CTA (calm) ─────────────────────────────────────────────────────────── */
.cta { border-top: 1px solid var(--line); background: var(--bg-soft); }
.cta-inner { max-width: var(--max); margin: 0 auto; padding: 5.5rem 1.75rem; text-align: center; }
.cta-inner h2 { font-size: clamp(1.7rem, 3.4vw, 2.3rem); letter-spacing: -0.034em; font-weight: 600; margin: 0 0 0.85rem; }
.cta-inner p { color: var(--muted); font-size: 1.08rem; margin: 0 auto 1.9rem; max-width: 34rem; letter-spacing: -0.012em; }

/* ── Footer ─────────────────────────────────────────────────────────────── */
.site-footer { border-top: 1px solid var(--line); }
.footer-inner { max-width: var(--max); margin: 0 auto; padding: 3.5rem 1.75rem 2rem; display: grid; grid-template-columns: 1.6fr 1fr 1fr 1fr; gap: 2rem; }
@media (max-width: 720px) { .footer-inner { grid-template-columns: 1fr 1fr; gap: 1.75rem; } }
.footer-brand .brand { margin-bottom: 0.7rem; }
.footer-brand p { color: var(--muted); font-size: 0.86rem; line-height: 1.5; margin: 0; max-width: 17rem; letter-spacing: -0.01em; }
.fcol { display: flex; flex-direction: column; gap: 0.55rem; }
.fcol strong { font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--faint); font-weight: 600; margin-bottom: 0.15rem; }
.fcol a { color: var(--ink-2); font-size: 0.89rem; letter-spacing: -0.01em; }
.fcol a:hover { color: var(--accent); }
.footer-base { max-width: var(--max); margin: 0 auto; padding: 1.4rem 1.75rem 2.5rem; border-top: 1px solid var(--line); color: var(--faint); font-size: 0.82rem; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; }

/* ── Prose (blog + changelog) ───────────────────────────────────────────── */
.prose-shell { max-width: 44rem; margin: 0 auto; padding: 4.5rem 1.75rem 5rem; min-width: 0; }
.prose-shell > h1 { font-size: clamp(2rem, 4vw, 2.6rem); line-height: 1.12; letter-spacing: -0.034em; font-weight: 600; margin: 0 0 0.5rem; }
.prose-lede { color: var(--muted); font-size: 1.1rem; margin: 0 0 2.25rem; letter-spacing: -0.012em; }
.prose-back { font-size: 0.88rem; margin: 0 0 1.4rem; }
.prose-back a { color: var(--muted); } .prose-back a:hover { color: var(--accent); }
.post-meta { color: var(--faint); font-size: 0.88rem; margin: 0 0 2rem; }
.post-list { list-style: none; margin: 0; padding: 0; }
.post-list li { padding: 1.6rem 0; border-bottom: 1px solid var(--line); }
.post-list li:first-child { padding-top: 0.5rem; }
.post-list time { display: block; color: var(--faint); font-size: 0.8rem; letter-spacing: 0.01em; }
.post-link { display: inline-block; margin: 0.3rem 0; font-size: 1.22rem; font-weight: 580; color: var(--ink); letter-spacing: -0.022em; }
.post-link:hover { color: var(--accent); }
.post-list p { margin: 0.2rem 0 0; color: var(--muted); letter-spacing: -0.01em; }
.changelog-release { margin: 0 0 3rem; }
.changelog-release h2 { font-size: 1.4rem; margin: 2rem 0 0.5rem; letter-spacing: -0.025em; font-weight: 600; }
.changelog-release h2 time { color: var(--faint); font-size: 0.95rem; font-weight: 400; }

.prose { color: var(--ink-2); }
.prose h2 { font-size: 1.45rem; margin: 2.6rem 0 0.8rem; letter-spacing: -0.025em; font-weight: 600; color: var(--ink); }
.prose h3 { font-size: 1.14rem; margin: 1.9rem 0 0.5rem; font-weight: 600; color: var(--ink); }
.prose p, .prose li { font-size: 1.02rem; line-height: 1.7; }
.prose a { font-weight: 500; }
.prose code { font-family: var(--mono); font-size: 0.86em; background: var(--bg-soft); border: 1px solid var(--line-2); border-radius: 5px; padding: 0.1em 0.36em; }
.prose pre { background: var(--code-bg); border-radius: var(--r); padding: 1rem 1.15rem; overflow-x: auto; font-size: 0.84rem; line-height: 1.6; border: 1px solid var(--line-2); }
.prose pre code { background: none; border: none; padding: 0; font-size: inherit; }
.prose blockquote { margin: 1.4rem 0; padding: 0.2rem 1.1rem; border-left: 2px solid var(--accent-line); color: var(--muted); }
.prose table { border-collapse: collapse; width: 100%; margin: 1.4rem 0; font-size: 0.92rem; }
.prose th, .prose td { border-bottom: 1px solid var(--line); padding: 0.55rem 0.75rem; text-align: left; }
.prose th { color: var(--muted); font-weight: 540; }
.prose img { max-width: 100%; border-radius: 8px; }
.prose [data-rehype-pretty-code-figure] { position: relative; margin: 1.4rem 0; }
.prose [data-rehype-pretty-code-figure] pre { margin: 0; padding: 1rem 0; position: static; }
.prose [data-rehype-pretty-code-title] { font-family: var(--mono); font-size: 0.76rem; color: var(--faint); background: #15151a; border: 1px solid var(--line-2); border-bottom: none; border-radius: var(--r) var(--r) 0 0; padding: 0.5rem 1rem; }
.prose [data-rehype-pretty-code-title] + pre { border-radius: 0 0 var(--r) var(--r); }
.prose [data-rehype-pretty-code-figure] code { display: grid; }
.prose [data-line] { padding: 0 1.15rem; border-left: 2px solid transparent; }
.prose [data-highlighted-line] { background: rgba(139,140,240,0.1); border-left-color: var(--accent); }
.prose .rehype-pretty-copy { position: absolute; top: 0.5rem; right: 0.5rem; margin: 0; color: #c9d1d9; background: rgba(110,118,129,0.2); border: 1px solid rgba(240,246,252,0.12); border-radius: 6px; cursor: pointer; }
.prose .rehype-pretty-copy:hover { background: rgba(110,118,129,0.36); }
.prose .rehype-pretty-copy span { background-repeat: no-repeat; background-position: center; background-size: 0.9rem; }
@media (hover: none) { .prose .rehype-pretty-copy { opacity: 1; } }
.prose .lesto-pm-panel [data-rehype-pretty-code-figure] { margin: 0; }
.prose .lesto-pm-panel pre { border-radius: 0; }
.prose .lesto-pm-panel { position: relative; }

/* ── 404 ─────────────────────────────────────────────────────────────────── */
.site-404 { max-width: 36rem; margin: 0 auto; padding: 7rem 1.75rem; text-align: center; }
.site-404 h1 { font-size: 3rem; margin: 0 0 0.5rem; letter-spacing: -0.04em; font-weight: 600; }
.site-404 p { color: var(--muted); }

/* ── Quiet entrance motion (respects reduced-motion) ────────────────────── */
@media (prefers-reduced-motion: no-preference) {
  .rise { animation: rise 0.6s cubic-bezier(0.22, 1, 0.36, 1) both; }
  .rise-1 { animation-delay: 0.05s; } .rise-2 { animation-delay: 0.12s; }
  .rise-3 { animation-delay: 0.19s; } .rise-4 { animation-delay: 0.26s; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
}
` +
  calloutStyles +
  packageCommandStyles;
