/**
 * The landing page — the hand-built marketing front door at `/`.
 *
 * Design: refined & premium (see `./styles`). A clean canvas, a custom
 * one-substrate diagram as the hero figure, a quiet proof strip, hairline battery
 * cells with line icons, and minimal code panels. Every claim is held to the
 * binding guardrail in `docs/brand/messaging.md` — the queue is "at-least-once
 * with exactly-once completion", workflows are "step memoization" (not
 * crash-safe), AI is tagged preview, and the MCP wedge stays precise (no "migrate
 * the schema from Claude").
 */

import type { ReactElement, ReactNode } from "react";

import { DOCS_URL, GITHUB_URL } from "../site";

const NPM_URL = "https://www.npmjs.com/package/@lesto/web";

// ── Inline line icons (16px, stroke = currentColor) ────────────────────────
const icon = (paths: ReactNode): ReactElement => (
  <svg className="cell-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths}
  </svg>
);
const ICONS: Record<string, ReactElement> = {
  data: icon(<><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>),
  queue: icon(<><path d="M4 7h16M4 12h16M4 17h10" /></>),
  cache: icon(<><path d="M13 3 4 14h7l-1 7 9-11h-7z" /></>),
  auth: icon(<><circle cx="9" cy="9" r="4" /><path d="m13 13 7 7M16 20l4-4" /></>),
  authz: icon(<><path d="M12 3 5 6v5c0 4.2 2.9 7.5 7 9 4.1-1.5 7-4.8 7-9V6z" /><path d="m9.5 12 1.8 1.8L15 10" /></>),
  admin: icon(<><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9h16M9 9v11" /></>),
  mail: icon(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>),
  workflows: icon(<><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.5 6H15a3 3 0 0 1 3 3v6.5" /></>),
  flags: icon(<><path d="M5 21V4M5 4h11l-2 3 2 3H5" /></>),
  observability: icon(<><path d="M3 12h4l2.5-7 4 14L16 12h5" /></>),
  content: icon(<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 13h6M9 17h6" /></>),
  ai: icon(<><path d="M12 3v4M12 17v4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M3 12h4M17 12h4M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" /></>),
};

interface Battery { readonly key: string; readonly name: string; readonly desc: string; readonly preview?: boolean }
const BATTERIES: readonly Battery[] = [
  { key: "data", name: "Data & migrations", desc: "A typed query builder over one SqlDatabase — relational queries with joins — plus versioned up/down migrations. Not an ORM; the boundary is on purpose." },
  { key: "queue", name: "Queue", desc: "A database-backed job queue: at-least-once delivery with exactly-once completion, retries, batches with dependencies, and an operator dashboard. No Redis." },
  { key: "cache", name: "Cache & Pub/Sub", desc: "A keyed cache and publish/subscribe, both on the SQL database you already have — nothing else to provision." },
  { key: "auth", name: "Auth", desc: "Register, verify, login, password reset, and two-factor TOTP, with sessions that work on both Node and the edge." },
  { key: "authz", name: "Authorization", desc: "Role-based access control with grants, wildcards, and inheritance. Guard one route or a whole subtree." },
  { key: "admin", name: "Admin", desc: "A typed CRUD backbone over your tables, with validation, a field allow-list, and a mutation hook for auditing." },
  { key: "mail", name: "Email & lists", desc: "Transport-agnostic transactional mail, plus double-opt-in mailing lists and broadcasts." },
  { key: "workflows", name: "Workflows", desc: "Multi-step workflows with resumable step memoization, so a re-run skips the work it already finished." },
  { key: "flags", name: "Feature flags", desc: "Typed flags with safe defaults; gate a route or a subtree behind one." },
  { key: "observability", name: "Observability", desc: "Built-in distributed tracing that stitches one trace from the browser click to the database query, exported over OTLP." },
  { key: "content", name: "Content engine", desc: "Schema-driven collections, Markdown/MDX, and a store with a CLI and MCP seam. (Search, embeddings, and prose tooling are preview.)" },
  { key: "ai", name: "AI primitives", desc: "Provider-agnostic text, streaming, an agent loop, retrieval, and evals over an injected transport.", preview: true },
];

interface CompareRow { readonly label: string; readonly lesto: string; readonly next: string; readonly rails: string; readonly supabase: string }
const COMPARE: readonly CompareRow[] = [
  { label: "Backend batteries", lesto: "In-house, first-party", next: "Assemble from vendors", rails: "In-house", supabase: "Postgres-as-platform" },
  { label: "Jobs / queue", lesto: "On the SQL DB, no Redis", next: "Third-party", rails: "Solid Queue / Horizon", supabase: "pg-based (pgmq)" },
  { label: "Auth / RBAC", lesto: "In-house", next: "Third-party", rails: "In-house / packages", supabase: "Built-in (GoTrue)" },
  { label: "One DB substrate", lesto: "SQLite → Postgres", next: "No", rails: "Mostly", supabase: "Postgres" },
  { label: "Edge-deployable", lesto: "Cloudflare Workers", next: "Yes (Vercel)", rails: "No", supabase: "N/A" },
  { label: "Agent / MCP control", lesto: "Operates the app", next: "No", rails: "No", supabase: "No" },
];

const GhIcon = (): ReactElement => (
  <svg className="ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.5 2 2 6.6 2 12.2c0 4.5 2.9 8.3 6.8 9.6.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.4-3.4-1.4-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 3.9-1.3 6.8-5.1 6.8-9.6C22 6.6 17.5 2 12 2z" /></svg>
);
const ArrowIcon = (): ReactElement => (
  <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);

/** The signature visual: batteries converging onto a single SQL substrate. */
function OneSubstrate(): ReactElement {
  const chips = ["Queue", "Cache", "Auth", "Jobs", "Pub/Sub", "Search", "Mail"];
  const W = 820, cw = 88, step = 114, m = 24, top = 22, ch = 30;
  const cx = (i: number): number => m + i * step + cw / 2;
  const baseW = 500, baseX = (W - baseW) / 2, baseY = 214, baseH = 58;
  const land = (i: number): number => baseX + 40 + (i * (baseW - 80)) / (chips.length - 1);
  return (
    <svg className="diagram" viewBox={`0 0 ${W} 290`} role="img" aria-label="Every battery — queue, cache, auth, jobs, pub/sub, search, mail — built on one SQL database.">
      {chips.map((c, i) => {
        const x = m + i * step;
        return (
          <g key={c}>
            <path className="d-wire" d={`M ${cx(i)} ${top + ch} C ${cx(i)} 140, ${land(i)} 140, ${land(i)} ${baseY}`} />
            <rect className="d-chip" x={x} y={top} width={cw} height={ch} rx="8" />
            <text className="d-chip-tx" x={x + cw / 2} y={top + ch / 2 + 4} textAnchor="middle" fontSize="12.5">{c}</text>
            <circle className="d-node" cx={cx(i)} cy={top + ch} r="2.4" />
            <circle className="d-node" cx={land(i)} cy={baseY} r="2.4" />
          </g>
        );
      })}
      <rect className="d-base" x={baseX} y={baseY} width={baseW} height={baseH} rx="13" />
      <text className="d-base-tx" x={baseX + baseW / 2} y={baseY + 26} textAnchor="middle" fontSize="15.5">One SQL database</text>
      <text className="d-base-sub" x={baseX + baseW / 2} y={baseY + 45} textAnchor="middle" fontSize="11.5">SQLite → Postgres · no Redis, no broker</text>
      <text className="d-cap" x={W / 2} y={284} textAnchor="middle" fontSize="10.5">ONE SUBSTRATE</text>
    </svg>
  );
}

function Hero(): ReactElement {
  return (
    <section className="hero">
      <div className="hero-inner">
        <a className="hero-eyebrow rise" href={NPM_URL} data-analytics="hero_npm">
          <span className="tag">v0.1</span> now on npm <span className="arw">→</span>
        </a>
        <h1 className="rise rise-1">
          Batteries-included.
          <br />
          <span className="dim">Agent-native.</span>
        </h1>
        <p className="hero-sub rise rise-2">
          The full-stack TypeScript framework you can drive from Claude, the CLI, or code — with the
          hard parts in the box, on one database, deployable to the edge.
        </p>
        <div className="hero-cta rise rise-3">
          <a className="btn btn-primary" href={`${DOCS_URL}/quickstart`} data-analytics="hero_get_started">
            Get started <ArrowIcon />
          </a>
          <a className="btn btn-ghost" href={GITHUB_URL} data-analytics="hero_github">
            <GhIcon /> GitHub
          </a>
        </div>
        <div className="hero-cmd rise rise-3">
          <span className="pr">$</span> <code>npm create lesto@latest</code>
        </div>
      </div>
      <div className="hero-figure rise rise-4">
        <OneSubstrate />
      </div>
    </section>
  );
}

function Proof(): ReactElement {
  const items = [
    <>MIT licensed</>,
    <>Strict TypeScript · ESM</>,
    <>SQLite → Postgres</>,
    <>Runs on the Cloudflare edge</>,
    <>100% tested on the supported surface</>,
  ];
  return (
    <div className="proof">
      <div className="proof-row">
        {items.map((it, i) => (
          <span key={i} style={{ display: "contents" }}>
            {i > 0 ? <span className="proof-sep" /> : null}
            <span className="proof-item">
              <span className="dot" /> {it}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Batteries(): ReactElement {
  return (
    <section className="section">
      <div className="section-head center">
        <span className="eyebrow">One substrate</span>
        <h2 className="section-title">The hard parts, first-party — built on the database</h2>
        <p className="section-lede">
          Next, Remix, and Astro give you a world-class frontend and a blank page for the backend.
          Lesto ships the backend Rails and Laravel made standard — every battery an in-house API on
          one SQL database. No service zoo to wire and pay for.
        </p>
      </div>
      <div className="bgrid">
        {BATTERIES.map((b) => (
          <div className="cell" key={b.key}>
            {b.preview === true ? <span className="cell-tag">Preview</span> : null}
            <h3 className="cell-h">
              {ICONS[b.key]} {b.name}
            </h3>
            <p className="cell-d">{b.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function AgentNative(): ReactElement {
  return (
    <section className="section">
      <div className="split">
        <div>
          <span className="eyebrow">Not just a backend for agents</span>
          <h2>Drive the running app from an agent</h2>
          <p>
            A backend “for agents” hands your code a database and functions to call. Lesto inverts
            that: the agent operates the running app itself.
          </p>
          <p>
            Every capability is an operation in one core layer, and the CLI, the visual UI, and the{" "}
            <strong>Lesto MCP server</strong> are three equal front-ends over it. From Claude or
            ChatGPT you publish and edit content, generate UI, and inspect and drive the live app —
            read-only by default, destructive actions gated, every action audited.
          </p>
          <p className="fine">Schema migrations stay in the CLI and code for now — not over MCP.</p>
        </div>
        <div className="split-media">
          <div className="panel" aria-hidden="true">
            <div className="panel-bar">
              <span className="label">claude <span className="accent">· lesto-mcp</span></span>
            </div>
            <pre>
              <code>
                <span className="c-com">“Publish the launch post and add a /pricing page.”</span>
                {"\n\n"}
                <span className="c-fn">create_content_entry</span> <span className="c-mut">blog/launch-day</span>   <span className="c-ok">✓ created</span>
                {"\n"}
                <span className="c-fn">generate_ui</span>          <span className="c-mut">/pricing</span>          <span className="c-ok">✓ rendered</span>
                {"\n"}
                <span className="c-fn">handle_request</span>       <span className="c-mut">GET /pricing</span> <span className="c-num">200</span>  <span className="c-ok">✓ verified</span>
                {"\n"}
                <span className="c-fn">list_routes</span>          <span className="c-mut">42 routes</span>         <span className="c-ok">✓</span>
              </code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

function AppShape(): ReactElement {
  return (
    <section className="section">
      <div className="split rev">
        <div>
          <span className="eyebrow">One app, two tiers</span>
          <h2>Write it once. Ship it to the edge.</h2>
          <p>
            A Lesto app is a <code>lesto()</code> builder — routes, pages, and middleware chained
            into one value. The same source runs in a long-lived Node process in development and
            wraps into a Cloudflare Worker for production.
          </p>
          <p>
            Same routing, same data layer, same security hardening on both tiers. No second framework
            for production, no rewrite to reach the edge.
          </p>
          <p>
            <a className="more" href={`${DOCS_URL}/concepts`} data-analytics="appshape_concepts">
              Read how the pieces fit →
            </a>
          </p>
        </div>
        <div className="split-media">
          <div className="panel" aria-hidden="true">
            <div className="panel-bar">
              <span className="label">app.ts</span>
            </div>
            <pre>
              <code>
                <span className="c-key">import</span> {"{ lesto }"} <span className="c-key">from</span> <span className="c-str">"@lesto/web"</span>;
                {"\n\n"}
                <span className="c-key">export const</span> app = <span className="c-fn">lesto</span>()
                {"\n  "}.<span className="c-fn">page</span>(<span className="c-str">"/"</span>, {"{ "}component: Home {"}"})
                {"\n  "}.<span className="c-fn">get</span>(<span className="c-str">"/api/health"</span>, (c) =&gt; c.<span className="c-fn">json</span>({"{ ok: "}<span className="c-key">true</span>{" }"}));
              </code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

function Compare(): ReactElement {
  return (
    <section className="section">
      <div className="section-head center">
        <span className="eyebrow">An honest comparison</span>
        <h2 className="section-title">Where Lesto sits</h2>
        <p className="section-lede">
          A framework is a set of trade-offs. We respect Next.js, Rails, Laravel, and Supabase — and
          borrow their best ideas openly.
        </p>
      </div>
      <div className="cmp-wrap">
        <div className="cmp-scroll">
          <table className="cmp">
            <thead>
              <tr>
                <th> </th>
                <th className="lesto">Lesto</th>
                <th>Next.js</th>
                <th>Rails / Laravel</th>
                <th>Supabase</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((row) => (
                <tr key={row.label}>
                  <th>{row.label}</th>
                  <td className="lesto">{row.lesto}</td>
                  <td>{row.next}</td>
                  <td>{row.rails}</td>
                  <td>{row.supabase}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function HonestStatus(): ReactElement {
  const cols = [
    { pip: "ok", label: "Shipped & supported", items: ["Data layer + migrations", "Queue, cache, pub/sub", "Mail + mailing lists, webhooks", "Auth + RBAC", "Router, kernel, React SSR + islands", "Admin surface", "Browser → server tracing", "Content store / engine / CLI / MCP", "Cloudflare + Node deploy"] },
    { pip: "preview", label: "Preview — may change", items: ["Content search (to ~10k docs)", "Embeddings", "Prose / lint / SEO tooling", "Content components beyond HtmlContent", "AI primitives"] },
    { pip: "deferred", label: "Deferred — post-1.0", items: ["Plugin / theme extensibility", "Crash-safe durable workflows", "Realtime over the wire", "A managed “Lesto Cloud”"] },
  ] as const;
  return (
    <section className="section">
      <div className="section-head center">
        <span className="eyebrow">Credibility over conversion</span>
        <h2 className="section-title">Exactly what is load-bearing today</h2>
        <p className="section-lede">
          Lesto is young and holds a strict bar. Here is what ships, what is preview, and what is
          deferred — if a docs page doesn’t say preview, it’s held to the full bar.
        </p>
      </div>
      <div className="status-grid">
        {cols.map((col) => (
          <div className="status-col" key={col.label}>
            <h3>
              <span className={`pip ${col.pip}`} /> {col.label}
            </h3>
            <ul>
              {col.items.map((it) => (
                <li key={it}>{it}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function Cta(): ReactElement {
  return (
    <div className="cta">
      <div className="cta-inner">
        <h2>Own a coherent stack — and an agent that can drive it</h2>
        <p>
          The Quickstart scaffolds a real app — typed schema, a migration, an SSR page with a
          hydrated island, a JSON API, security on by default — running locally in about five
          minutes.
        </p>
        <div className="hero-cta">
          <a className="btn btn-primary" href={`${DOCS_URL}/quickstart`} data-analytics="cta_quickstart">
            Start the Quickstart <ArrowIcon />
          </a>
          <a className="btn btn-ghost" href="/use-cases" data-analytics="cta_use_cases">
            See what you can build
          </a>
        </div>
      </div>
    </div>
  );
}

export function Landing(): ReactElement {
  return (
    <>
      <Hero />
      <Proof />
      <Batteries />
      <AgentNative />
      <AppShape />
      <Compare />
      <HonestStatus />
      <Cta />
    </>
  );
}
