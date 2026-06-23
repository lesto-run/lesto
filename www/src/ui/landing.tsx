/**
 * The landing page — the hand-built marketing front door at `/`.
 *
 * Not Markdown: it is a React component registered as a `static: true` page in
 * `src/app.ts` and prerendered to `out/www/index.html`. Every claim here is held
 * to the binding guardrail in `docs/brand/messaging.md` — the MCP wedge is stated
 * precisely (operate content/UI/requests, not "migrate the schema from Claude"),
 * AI is tagged preview, workflows are "resumable step memoization" (not
 * "crash-safe"), and there is no visual-CMS or "Lesto Cloud" claim.
 */

import type { ReactElement } from "react";

import { DOCS_URL, GITHUB_URL } from "../site";

/** One battery card: a name and an honest one-liner; `preview` shows the tag. */
interface Battery {
  readonly name: string;
  readonly desc: string;
  readonly preview?: boolean;
}

const BATTERIES: readonly Battery[] = [
  { name: "Data & migrations", desc: "A typed query builder over one SqlDatabase — relational queries with joins — plus versioned up/down migrations. Not an ORM; the boundary is on purpose." },
  { name: "Queue", desc: "A database-backed job queue: at-least-once delivery with exactly-once completion, retries, batches with dependencies, and an operator dashboard. No Redis, no broker." },
  { name: "Cache & Pub/Sub", desc: "A keyed cache and publish/subscribe, both on the SQL database you already have — nothing else to provision." },
  { name: "Auth", desc: "Register, verify, login, password reset, and two-factor TOTP, with sessions that work on both Node and the edge." },
  { name: "Authorization", desc: "Role-based access control with grants, wildcards, and inheritance. Guard one route or a whole subtree." },
  { name: "Admin", desc: "A typed CRUD backbone over your tables, with validation, a field allow-list, and a mutation hook for auditing." },
  { name: "Email & lists", desc: "Transport-agnostic transactional mail, plus double-opt-in mailing lists and broadcasts." },
  { name: "Workflows", desc: "Multi-step workflows with resumable step memoization, so a re-run skips the work it already finished." },
  { name: "Feature flags", desc: "Typed flags with safe defaults; gate a route or a subtree behind one." },
  { name: "Observability", desc: "Built-in distributed tracing — a span per request, exported over OTLP — that stitches one trace from the browser click to the database query." },
  { name: "Content engine", desc: "Schema-driven collections, Markdown/MDX, and a store with a CLI and MCP seam. (Search, embeddings, and prose tooling are preview.)" },
  { name: "AI primitives", desc: "Provider-agnostic text, streaming, an agent loop, retrieval, and evals over an injected transport.", preview: true },
];

/** One comparison row: the dimension and a cell per framework. */
interface CompareRow {
  readonly label: string;
  readonly lesto: string;
  readonly next: string;
  readonly rails: string;
  readonly supabase: string;
}

const COMPARE: readonly CompareRow[] = [
  { label: "Backend batteries", lesto: "In-house, first-party", next: "Assemble from vendors", rails: "In-house", supabase: "Postgres-as-platform" },
  { label: "Jobs / queue", lesto: "On the SQL DB, no Redis", next: "Third-party", rails: "Solid Queue / Horizon", supabase: "pg-based (pgmq)" },
  { label: "Auth / RBAC", lesto: "In-house", next: "Third-party", rails: "In-house / packages", supabase: "Built-in (GoTrue)" },
  { label: "One DB substrate", lesto: "SQLite → Postgres", next: "No", rails: "Mostly", supabase: "Postgres" },
  { label: "Edge-deployable", lesto: "Cloudflare Workers", next: "Yes (Vercel)", rails: "No", supabase: "N/A" },
  { label: "Agent / MCP control", lesto: "Operates the app", next: "No", rails: "No", supabase: "No" },
];

function Hero(): ReactElement {
  return (
    <section className="hero">
      <div className="hero-inner">
        <span className="hero-eyebrow">The batteries-included, agent-native framework</span>
        <h1 className="hero-title">
          Batteries-included.
          <span className="accent">Agent-native.</span>
        </h1>
        <p className="hero-sub">
          The full-stack TypeScript framework you can drive from Claude, the CLI, or code. The hard
          parts — queue, auth, cache, workflows, email, admin, content — in the box, on one database,
          deployable to the edge.
        </p>
        <div className="hero-cta">
          <a className="btn btn-primary" href={`${DOCS_URL}/quickstart`} data-analytics="hero_get_started">
            Get started
          </a>
          <a className="btn btn-ghost" href={GITHUB_URL} data-analytics="hero_github">
            Star on GitHub
          </a>
        </div>
        <div className="hero-install">
          <span className="prompt">$</span>
          <span className="pkg">npm create lesto@latest</span>
        </div>
      </div>
    </section>
  );
}

function Batteries(): ReactElement {
  return (
    <section className="section" id="batteries">
      <div className="section-head">
        <span className="eyebrow">One substrate</span>
        <h2 className="section-title">The hard parts, first-party — built on the database</h2>
        <p className="section-lede">
          Next, Remix, and Astro give you a world-class frontend and a blank page for the backend.
          Lesto ships the backend Rails and Laravel made standard — every battery an in-house API on
          one SQL database (SQLite local, Postgres at scale). No service zoo to wire and pay for.
        </p>
      </div>
      <div className="grid">
        {BATTERIES.map((b) => (
          <div className="card" key={b.name}>
            {b.preview === true ? <span className="card-tag">Preview</span> : null}
            <h3 className="card-title">
              <span className="card-dot" /> {b.name}
            </h3>
            <p className="card-desc">{b.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function AgentNative(): ReactElement {
  return (
    <div className="band">
      <section className="section">
        <div className="band-grid">
          <div>
            <span className="eyebrow">Not just a backend for agents</span>
            <h2>Drive the running app from an agent</h2>
            <p>
              A backend <em>“for agents”</em> hands your code a database and functions to call. Lesto
              inverts that: the agent operates the running app itself.
            </p>
            <p>
              Every Lesto capability is an operation in one core layer, and the CLI, the visual UI,
              and the <strong>Lesto MCP server</strong> are three equal front-ends over it. From an
              MCP client inside Claude or ChatGPT you publish and edit content, generate UI, and
              inspect and drive the live app.
            </p>
            <p>
              Read-only by default; destructive actions are gated behind an explicit mode, and every
              action is audited.
            </p>
            <p className="fine">
              Schema migrations stay in the CLI and code for now — not over MCP.
            </p>
          </div>
          <div className="terminal" aria-hidden="true">
            <div className="terminal-bar">
              <i />
              <i />
              <i />
              <span>claude · lesto-mcp</span>
            </div>
            <pre>
              <code>
                <span className="c-com">{"// “Publish the launch post and add a /pricing page.”"}</span>
                {"\n\n"}
                <span className="c-fn">create_content_entry</span>  blog/launch-day     <span className="c-ok">✓ created</span>
                {"\n"}
                <span className="c-fn">generate_ui</span>           /pricing            <span className="c-ok">✓ rendered</span>
                {"\n"}
                <span className="c-fn">handle_request</span>        GET /pricing  <span className="c-str">200</span>   <span className="c-ok">✓ verified</span>
                {"\n"}
                <span className="c-fn">list_routes</span>           42 routes           <span className="c-ok">✓</span>
              </code>
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}

function AppShape(): ReactElement {
  return (
    <section className="section">
      <div className="band-grid">
        <div className="terminal" aria-hidden="true">
          <div className="terminal-bar">
            <i />
            <i />
            <i />
            <span>app.ts</span>
          </div>
          <pre>
            <code>
              <span className="c-key">import</span> {"{ lesto }"} <span className="c-key">from</span>{" "}
              <span className="c-str">"@lesto/web"</span>;
              {"\n\n"}
              <span className="c-key">export const</span> app = <span className="c-fn">lesto</span>()
              {"\n  "}.<span className="c-fn">page</span>(<span className="c-str">"/"</span>,{" {"}{" "}component: Home {"})"}
              {"\n  "}.<span className="c-fn">get</span>(<span className="c-str">"/api/health"</span>, (c) =&gt;
              {" "}c.<span className="c-fn">json</span>({"{ ok: "}<span className="c-key">true</span>{" }"}));
            </code>
          </pre>
        </div>
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
            <a href={`${DOCS_URL}/concepts`} data-analytics="appshape_concepts">
              Read how the pieces fit →
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}

function Compare(): ReactElement {
  return (
    <section className="section" id="compare">
      <div className="section-head">
        <span className="eyebrow">An honest comparison</span>
        <h2 className="section-title">Where Lesto sits</h2>
        <p className="section-lede">
          A framework is a set of trade-offs. We respect Next.js, Rails, Laravel, and Supabase — and
          borrow their best ideas openly.
        </p>
      </div>
      <div className="compare-wrap">
        <table className="compare">
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
    </section>
  );
}

function HonestStatus(): ReactElement {
  return (
    <section className="section tight" id="status">
      <div className="section-head">
        <span className="eyebrow">Credibility over conversion</span>
        <h2 className="section-title">Exactly what is load-bearing today</h2>
        <p className="section-lede">
          Lesto is young and holds a strict bar — strict TypeScript, ESM, 100% test coverage on its
          supported surface, stable error codes. Here is what ships, what is preview, and what is
          deferred. If a docs page does not say preview, it is held to the full bar.
        </p>
      </div>
      <div className="status-grid">
        <div className="status-col">
          <h3>
            Shipped <span className="chip ok">Supported</span>
          </h3>
          <ul>
            <li>Data layer + migrations</li>
            <li>Queue, cache, pub/sub</li>
            <li>Mail + mailing lists, webhooks</li>
            <li>Auth + RBAC</li>
            <li>Router, kernel, React SSR + islands</li>
            <li>Admin surface</li>
            <li>Browser → server tracing</li>
            <li>Content store / engine / CLI / MCP</li>
            <li>Cloudflare + Node deploy</li>
          </ul>
        </div>
        <div className="status-col">
          <h3>
            Preview <span className="chip preview">May change</span>
          </h3>
          <ul>
            <li>Content search (to ~10k docs)</li>
            <li>Embeddings</li>
            <li>Prose / lint / SEO tooling</li>
            <li>Content components beyond HtmlContent</li>
            <li>AI primitives</li>
          </ul>
        </div>
        <div className="status-col">
          <h3>
            Deferred <span className="chip deferred">Post-1.0</span>
          </h3>
          <ul>
            <li>Plugin / theme extensibility</li>
            <li>Crash-safe durable workflows (step memoization ships today)</li>
            <li>Realtime over the wire (DB pub/sub ships)</li>
            <li>A managed “Lesto Cloud”</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function CtaBand(): ReactElement {
  return (
    <div className="cta-band">
      <section className="section">
        <h2>Own a coherent stack — and an agent that can drive it</h2>
        <p>
          The Quickstart scaffolds a real app — typed schema, a migration, an SSR page with a
          hydrated island, a JSON API, security on by default — running locally in about five
          minutes.
        </p>
        <div className="hero-cta">
          <a className="btn btn-primary" href={`${DOCS_URL}/quickstart`} data-analytics="cta_quickstart">
            Start the Quickstart
          </a>
          <a className="btn btn-ghost" href="/use-cases" data-analytics="cta_use_cases">
            See what you can build
          </a>
        </div>
      </section>
    </div>
  );
}

/** The whole landing page, top to bottom. */
export function Landing(): ReactElement {
  return (
    <>
      <Hero />
      <Batteries />
      <AgentNative />
      <AppShape />
      <Compare />
      <HonestStatus />
      <CtaBand />
    </>
  );
}
