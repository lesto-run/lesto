/**
 * The landing page — the hand-built marketing front door at `/`.
 *
 * Design: refined & premium, now expressed in Tailwind utilities compiled by
 * `@lesto/styles` (the site dogfoods Lesto's own CSS pipeline, ADR 0037). Layout,
 * type, color, and state are utility classes; the irreducible flourishes — the
 * one-substrate diagram (`.diagram`), the code-window panels (`.panel`), and the
 * entrance animation (`.rise`) — live as custom CSS in `app/styles/app.css`.
 *
 * Every claim is held to the binding guardrail in `docs/brand/messaging.md` — the
 * queue is "at-least-once with exactly-once completion", workflows are "step
 * memoization" (not crash-safe), AI is tagged preview, and the MCP wedge stays
 * precise (no "migrate the schema from Claude").
 */

import type { ReactElement, ReactNode } from "react";

import { DOCS_URL, GITHUB_URL } from "../site";

const NPM_URL = "https://www.npmjs.com/package/@lesto/web";

// The shared pill-button recipes (the one place the button look is defined).
const BTN =
  "inline-flex items-center gap-[0.45rem] text-[0.95rem] font-[540] tracking-[-0.01em] px-[1.2rem] py-[0.6rem] rounded-full border border-transparent transition-all";
const BTN_PRIMARY = `${BTN} bg-accent text-white shadow-[0_1px_2px_rgba(20,18,60,0.18),inset_0_1px_0_rgba(255,255,255,0.16)] hover:bg-accent-ink hover:-translate-y-px hover:shadow-[0_6px_18px_-8px_color-mix(in_srgb,var(--accent)_70%,transparent)]`;
const BTN_GHOST = `${BTN} bg-panel text-ink border-line-2 hover:border-faint hover:-translate-y-px`;

// ── Inline line icons (16px, stroke = currentColor) ────────────────────────
const icon = (paths: ReactNode): ReactElement => (
  <svg
    className="w-[17px] h-[17px] text-accent shrink-0"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {paths}
  </svg>
);
const ICONS: Record<string, ReactElement> = {
  data: icon(
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </>,
  ),
  queue: icon(
    <>
      <path d="M4 7h16M4 12h16M4 17h10" />
    </>,
  ),
  cache: icon(
    <>
      <path d="M13 3 4 14h7l-1 7 9-11h-7z" />
    </>,
  ),
  auth: icon(
    <>
      <circle cx="9" cy="9" r="4" />
      <path d="m13 13 7 7M16 20l4-4" />
    </>,
  ),
  authz: icon(
    <>
      <path d="M12 3 5 6v5c0 4.2 2.9 7.5 7 9 4.1-1.5 7-4.8 7-9V6z" />
      <path d="m9.5 12 1.8 1.8L15 10" />
    </>,
  ),
  admin: icon(
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9h16M9 9v11" />
    </>,
  ),
  mail: icon(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>,
  ),
  workflows: icon(
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.5 6H15a3 3 0 0 1 3 3v6.5" />
    </>,
  ),
  flags: icon(
    <>
      <path d="M5 21V4M5 4h11l-2 3 2 3H5" />
    </>,
  ),
  observability: icon(
    <>
      <path d="M3 12h4l2.5-7 4 14L16 12h5" />
    </>,
  ),
  content: icon(
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 13h6M9 17h6" />
    </>,
  ),
  ai: icon(
    <>
      <path d="M12 3v4M12 17v4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M3 12h4M17 12h4M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
    </>,
  ),
};

interface Battery {
  readonly key: string;
  readonly name: string;
  readonly desc: string;
  readonly preview?: boolean;
}
const BATTERIES: readonly Battery[] = [
  {
    key: "data",
    name: "Data & migrations",
    desc: "A typed query builder over one SqlDatabase — relational queries with joins — plus versioned up/down migrations. Not an ORM; the boundary is on purpose.",
  },
  {
    key: "queue",
    name: "Queue",
    desc: "A database-backed job queue: at-least-once delivery with exactly-once completion, retries, batches with dependencies, and an operator dashboard. No Redis.",
  },
  {
    key: "cache",
    name: "Cache & Pub/Sub",
    desc: "A keyed cache and publish/subscribe, both on the SQL database you already have — nothing else to provision.",
  },
  {
    key: "auth",
    name: "Auth",
    desc: "Register, verify, login, password reset, and two-factor TOTP, with sessions that work on both Node and the edge.",
  },
  {
    key: "authz",
    name: "Authorization",
    desc: "Role-based access control with grants, wildcards, and inheritance. Guard one route or a whole subtree.",
  },
  {
    key: "admin",
    name: "Admin",
    desc: "A typed CRUD backbone over your tables, with validation, a field allow-list, and a mutation hook for auditing.",
  },
  {
    key: "mail",
    name: "Email & lists",
    desc: "Transport-agnostic transactional mail, plus double-opt-in mailing lists and broadcasts.",
  },
  {
    key: "workflows",
    name: "Workflows",
    desc: "Multi-step workflows with resumable step memoization, so a re-run skips the work it already finished.",
  },
  {
    key: "flags",
    name: "Feature flags",
    desc: "Typed flags with safe defaults; gate a route or a subtree behind one.",
  },
  {
    key: "observability",
    name: "Observability",
    desc: "Built-in distributed tracing that stitches one trace from the browser click to the database query, exported over OTLP.",
  },
  {
    key: "content",
    name: "Content engine",
    desc: "Schema-driven collections, Markdown/MDX, and a store with a CLI and MCP seam. (Search, embeddings, and prose tooling are preview.)",
  },
  {
    key: "ai",
    name: "AI primitives",
    desc: "Provider-agnostic text, streaming, an agent loop, retrieval, and evals over an injected transport.",
    preview: true,
  },
];

interface CompareRow {
  readonly label: string;
  readonly lesto: string;
  readonly next: string;
  readonly rails: string;
  readonly supabase: string;
}
const COMPARE: readonly CompareRow[] = [
  {
    label: "Backend batteries",
    lesto: "In-house, first-party",
    next: "Assemble from vendors",
    rails: "In-house",
    supabase: "Postgres-as-platform",
  },
  {
    label: "Jobs / queue",
    lesto: "On the SQL DB, no Redis",
    next: "Third-party",
    rails: "Solid Queue / Horizon",
    supabase: "pg-based (pgmq)",
  },
  {
    label: "Auth / RBAC",
    lesto: "In-house",
    next: "Third-party",
    rails: "In-house / packages",
    supabase: "Built-in (GoTrue)",
  },
  {
    label: "One DB substrate",
    lesto: "SQLite → Postgres",
    next: "No",
    rails: "Mostly",
    supabase: "Postgres",
  },
  {
    label: "Edge-deployable",
    lesto: "Cloudflare Workers",
    next: "Yes (Vercel)",
    rails: "No",
    supabase: "N/A",
  },
  {
    label: "Agent / MCP control",
    lesto: "Operates the app",
    next: "No",
    rails: "No",
    supabase: "No",
  },
];

const GhIcon = (): ReactElement => (
  <svg className="w-[15px] h-[15px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2C6.5 2 2 6.6 2 12.2c0 4.5 2.9 8.3 6.8 9.6.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.4-3.4-1.4-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 3.9-1.3 6.8-5.1 6.8-9.6C22 6.6 17.5 2 12 2z" />
  </svg>
);
const ArrowIcon = (): ReactElement => (
  <svg
    className="w-[15px] h-[15px]"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

// ── Small section primitives (the repeated marketing-section shapes) ─────────
function Section({ first, children }: { first?: boolean; children: ReactNode }): ReactElement {
  // `.section + .section` dropped its top padding; the first section keeps it, the
  // rest are bottom-padded only — same rhythm, expressed per-section.
  return (
    <section
      className={`max-w-[1080px] mx-auto px-7 ${first === true ? "py-[6.5rem]" : "pb-[6.5rem]"}`}
    >
      {children}
    </section>
  );
}

function SectionHead({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="max-w-[40rem] mx-auto text-center mb-12">
      <span className="block text-[0.78rem] font-semibold tracking-[0.02em] text-accent-ink mb-[0.9rem]">
        {eyebrow}
      </span>
      <h2 className="text-[clamp(1.7rem,3.4vw,2.3rem)] leading-[1.12] tracking-[-0.032em] font-semibold mb-[0.9rem] text-ink">
        {title}
      </h2>
      <p className="text-[1.08rem] leading-[1.55] text-muted tracking-[-0.012em]">{children}</p>
    </div>
  );
}

const CELL_H =
  "flex items-center gap-[0.6rem] mb-2 text-[0.98rem] font-semibold tracking-[-0.015em] text-ink";
const CELL_D = "m-0 text-[0.9rem] leading-[1.55] text-muted tracking-[-0.008em]";

/** The signature visual: batteries converging onto a single SQL substrate. */
function OneSubstrate(): ReactElement {
  const chips = ["Queue", "Cache", "Auth", "Jobs", "Pub/Sub", "Search", "Mail"];
  const W = 820,
    cw = 88,
    step = 114,
    m = 24,
    top = 22,
    ch = 30;
  const cx = (i: number): number => m + i * step + cw / 2;
  const baseW = 500,
    baseX = (W - baseW) / 2,
    baseY = 214,
    baseH = 58;
  const land = (i: number): number => baseX + 40 + (i * (baseW - 80)) / (chips.length - 1);
  return (
    <svg
      className="diagram"
      viewBox={`0 0 ${W} 290`}
      role="img"
      aria-label="Every battery — queue, cache, auth, jobs, pub/sub, search, mail — built on one SQL database."
    >
      {chips.map((c, i) => {
        const x = m + i * step;
        return (
          <g key={c}>
            <path
              className="d-wire"
              d={`M ${cx(i)} ${top + ch} C ${cx(i)} 140, ${land(i)} 140, ${land(i)} ${baseY}`}
            />
            <rect className="d-chip" x={x} y={top} width={cw} height={ch} rx="8" />
            <text
              className="d-chip-tx"
              x={x + cw / 2}
              y={top + ch / 2 + 4}
              textAnchor="middle"
              fontSize="12.5"
            >
              {c}
            </text>
            <circle className="d-node" cx={cx(i)} cy={top + ch} r="2.4" />
            <circle className="d-node" cx={land(i)} cy={baseY} r="2.4" />
          </g>
        );
      })}
      <rect className="d-base" x={baseX} y={baseY} width={baseW} height={baseH} rx="13" />
      <text
        className="d-base-tx"
        x={baseX + baseW / 2}
        y={baseY + 26}
        textAnchor="middle"
        fontSize="15.5"
      >
        One SQL database
      </text>
      <text
        className="d-base-sub"
        x={baseX + baseW / 2}
        y={baseY + 45}
        textAnchor="middle"
        fontSize="11.5"
      >
        SQLite → Postgres · no Redis, no broker
      </text>
      <text className="d-cap" x={W / 2} y={284} textAnchor="middle" fontSize="10.5">
        ONE SUBSTRATE
      </text>
    </svg>
  );
}

function Hero(): ReactElement {
  return (
    <section className="hero border-b border-line">
      <div className="relative z-[1] max-w-[1080px] mx-auto px-7 pt-24 pb-12 text-center">
        <a
          className="rise inline-flex items-center gap-2 text-[0.8rem] font-medium text-muted pl-2 pr-[0.7rem] py-[0.3rem] mb-[1.9rem] border border-line-2 rounded-full bg-panel hover:text-ink hover:border-accent-line"
          href={NPM_URL}
          data-analytics="hero_npm"
        >
          <span className="font-semibold text-accent-ink bg-accent-soft border border-accent-line rounded-full px-[0.45rem] py-[0.05rem] text-[0.72rem] tracking-[0.01em]">
            v0.1
          </span>{" "}
          now on npm <span className="text-faint">→</span>
        </a>
        <h1 className="rise rise-1 text-[clamp(2.7rem,6.2vw,4.3rem)] leading-[1.02] tracking-[-0.04em] font-semibold mb-[1.4rem] text-ink">
          Batteries-included.
          <br />
          <span className="text-muted">Agent-native.</span>
        </h1>
        <p className="rise rise-2 max-w-[33rem] mx-auto mb-[2.3rem] text-[clamp(1.05rem,2.1vw,1.22rem)] leading-normal text-ink-2 tracking-[-0.013em]">
          The full-stack TypeScript framework you can drive from Claude, the CLI, or code — with the
          hard parts in the box, on one database, deployable to the edge.
        </p>
        <div className="rise rise-3 flex gap-[0.8rem] justify-center items-center flex-wrap">
          <a
            className={BTN_PRIMARY}
            href={`${DOCS_URL}/quickstart`}
            data-analytics="hero_get_started"
          >
            Get started <ArrowIcon />
          </a>
          <a className={BTN_GHOST} href={GITHUB_URL} data-analytics="hero_github">
            <GhIcon /> GitHub
          </a>
        </div>
        <div className="rise rise-3 inline-flex items-center gap-[0.6rem] mt-[1.7rem] font-mono text-[0.86rem] text-ink-2">
          <span className="text-faint">$</span>{" "}
          <code className="bg-bg-soft border border-line-2 rounded-[7px] px-[0.7rem] py-[0.4rem] text-ink">
            npm create lesto@latest
          </code>
        </div>
      </div>
      <div className="rise rise-4 relative z-[1] max-w-[720px] mx-auto mt-9 px-7 pb-4">
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
    <div className="border-b border-line bg-bg-soft">
      <div className="max-w-[1080px] mx-auto px-7 py-[1.05rem] flex flex-wrap items-center justify-center gap-x-6 gap-y-[0.85rem]">
        {items.map((it, i) => (
          <span key={i} style={{ display: "contents" }}>
            {i > 0 ? <span className="w-px h-[13px] bg-line-2 max-[680px]:hidden" /> : null}
            <span className="inline-flex items-center gap-[0.45rem] text-[0.83rem] text-muted tracking-[-0.01em] whitespace-nowrap">
              <span className="w-[5px] h-[5px] rounded-full bg-accent opacity-70" /> {it}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Batteries(): ReactElement {
  return (
    <Section first>
      <SectionHead
        eyebrow="One substrate"
        title="The hard parts, first-party — built on the database"
      >
        Next, Remix, and Astro give you a world-class frontend and a blank page for the backend.
        Lesto ships the backend Rails and Laravel made standard — every battery an in-house API on
        one SQL database. No service zoo to wire and pay for.
      </SectionHead>
      <div className="grid grid-cols-3 gap-px bg-line border border-line rounded-card overflow-hidden max-[820px]:grid-cols-2 max-[540px]:grid-cols-1">
        {BATTERIES.map((b) => (
          <div
            className="relative px-[1.55rem] py-6 bg-panel transition-colors hover:[background:radial-gradient(95%_80%_at_50%_-12%,color-mix(in_srgb,var(--accent)_9%,var(--panel)),var(--panel)_68%)]"
            key={b.key}
          >
            {b.preview === true ? (
              <span className="absolute top-6 right-6 text-[0.64rem] font-semibold tracking-[0.04em] uppercase text-warn">
                Preview
              </span>
            ) : null}
            <h3 className={CELL_H}>
              {ICONS[b.key]} {b.name}
            </h3>
            <p className={CELL_D}>{b.desc}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function AgentNative(): ReactElement {
  return (
    <Section>
      <div className="grid grid-cols-2 gap-14 items-center max-[860px]:grid-cols-1 max-[860px]:gap-8">
        <div>
          <span className="block text-[0.78rem] font-semibold tracking-[0.02em] text-accent-ink mb-[0.9rem]">
            Not just a backend for agents
          </span>
          <h2 className="text-[clamp(1.55rem,3vw,2.05rem)] leading-[1.15] tracking-[-0.03em] font-semibold mb-4">
            Drive the running app from an agent
          </h2>
          <p className="text-muted text-[1.02rem] leading-[1.6] mb-4 tracking-[-0.01em]">
            A backend “for agents” hands your code a database and functions to call. Lesto inverts
            that: the agent operates the running app itself.
          </p>
          <p className="text-muted text-[1.02rem] leading-[1.6] mb-4 tracking-[-0.01em]">
            Every capability is an operation in one core layer, and the CLI, the visual UI, and the{" "}
            <strong>Lesto MCP server</strong> are three equal front-ends over it. From Claude or
            ChatGPT you publish and edit content, generate UI (preview), and inspect and drive the
            live app —
            read-only by default, destructive actions gated, every action audited.
          </p>
          <p className="text-[0.86rem] text-faint">
            Schema migrations stay in the CLI and code for now — not over MCP.
          </p>
        </div>
        <div>
          <div className="panel" aria-hidden="true">
            <div className="panel-bar">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              <span className="panel-tab">
                claude <span className="accent">· lesto mcp --operator</span>
              </span>
            </div>
            <pre>
              <code>
                <span className="c-com">“Publish the launch post and add a /pricing page.”</span>
                {"\n\n"}
                <span className="c-fn">create_content_entry</span>{" "}
                <span className="c-mut">blog/launch-day</span>{" "}
                <span className="c-ok">✓ created</span>
                {"\n"}
                <span className="c-fn">generate_ui</span> <span className="c-mut">/pricing</span>{" "}
                <span className="c-ok">✓ rendered</span> <span className="c-com">preview</span>
                {"\n"}
                <span className="c-fn">handle_request</span>{" "}
                <span className="c-mut">GET /posts</span> <span className="c-num">200</span>{" "}
                <span className="c-ok">✓ verified</span>
                {"\n"}
                <span className="c-fn">list_routes</span> <span className="c-mut">42 routes</span>{" "}
                <span className="c-ok">✓</span>
              </code>
            </pre>
          </div>
        </div>
      </div>
    </Section>
  );
}

function AppShape(): ReactElement {
  return (
    <Section>
      <div className="grid grid-cols-2 gap-14 items-center max-[860px]:grid-cols-1 max-[860px]:gap-8">
        <div>
          <span className="block text-[0.78rem] font-semibold tracking-[0.02em] text-accent-ink mb-[0.9rem]">
            One app, two tiers
          </span>
          <h2 className="text-[clamp(1.55rem,3vw,2.05rem)] leading-[1.15] tracking-[-0.03em] font-semibold mb-4">
            Write it once. Ship it to the edge.
          </h2>
          <p className="text-muted text-[1.02rem] leading-[1.6] mb-4 tracking-[-0.01em]">
            A Lesto app is a <code className="font-mono text-[0.92em]">lesto()</code> builder —
            routes, pages, and middleware chained into one value. The same source runs in a
            long-lived Node process in development and wraps into a Cloudflare Worker for
            production.
          </p>
          <p className="text-muted text-[1.02rem] leading-[1.6] mb-4 tracking-[-0.01em]">
            Same routing, same data layer, same security hardening on both tiers. No second
            framework for production, no rewrite to reach the edge.
          </p>
          <p className="mb-4">
            <a
              className="font-[540] text-[0.95rem]"
              href={`${DOCS_URL}/concepts`}
              data-analytics="appshape_concepts"
            >
              Read how the pieces fit →
            </a>
          </p>
        </div>
        <div className="max-[860px]:order-none order-[-1]">
          <div className="panel numbered" aria-hidden="true">
            <div className="panel-bar">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              <span className="panel-tab">app.ts</span>
            </div>
            <pre>
              <code>
                <span className="cl">
                  <span className="c-key">import</span> {"{ lesto }"}{" "}
                  <span className="c-key">from</span> <span className="c-str">"@lesto/web"</span>;
                </span>
                <span className="cl"> </span>
                <span className="cl">
                  <span className="c-key">export const</span> app ={" "}
                  <span className="c-fn">lesto</span>()
                </span>
                <span className="cl">
                  {"  "}.<span className="c-fn">page</span>(<span className="c-str">"/"</span>,{" "}
                  {"{ "}component: Home {"}"})
                </span>
                <span className="cl">
                  {"  "}.<span className="c-fn">get</span>(
                  <span className="c-str">"/api/health"</span>, (c) =&gt; c.
                  <span className="c-fn">json</span>({"{ ok: "}
                  <span className="c-key">true</span>
                  {" }"}));
                </span>
              </code>
            </pre>
          </div>
        </div>
      </div>
    </Section>
  );
}

function Compare(): ReactElement {
  const cell = "px-[1.1rem] py-[0.85rem] text-left border-b border-line tracking-[-0.01em]";
  return (
    <Section>
      <SectionHead eyebrow="An honest comparison" title="Where Lesto sits">
        A framework is a set of trade-offs. We respect Next.js, Rails, Laravel, and Supabase — and
        borrow their best ideas openly.
      </SectionHead>
      <div className="border border-line rounded-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="border-collapse w-full text-[0.9rem] min-w-[640px] [&_tr:last-child_th]:border-b-0 [&_tr:last-child_td]:border-b-0">
            <thead>
              <tr>
                <th className={`${cell} font-[540] text-muted text-[0.82rem] bg-bg-soft`}> </th>
                <th className={`${cell} font-[540] text-[0.82rem] bg-bg-soft text-accent-ink`}>
                  Lesto
                </th>
                <th className={`${cell} font-[540] text-muted text-[0.82rem] bg-bg-soft`}>
                  Next.js
                </th>
                <th className={`${cell} font-[540] text-muted text-[0.82rem] bg-bg-soft`}>
                  Rails / Laravel
                </th>
                <th className={`${cell} font-[540] text-muted text-[0.82rem] bg-bg-soft`}>
                  Supabase
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((row) => (
                <tr key={row.label}>
                  <th className={`${cell} font-medium text-ink-2 whitespace-nowrap`}>
                    {row.label}
                  </th>
                  <td
                    className={`${cell} text-ink font-[540] bg-[color-mix(in_srgb,var(--accent)_4%,transparent)]`}
                  >
                    {row.lesto}
                  </td>
                  <td className={`${cell} text-muted`}>{row.next}</td>
                  <td className={`${cell} text-muted`}>{row.rails}</td>
                  <td className={`${cell} text-muted`}>{row.supabase}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}

function HonestStatus(): ReactElement {
  const cols = [
    {
      pip: "bg-ok",
      label: "Shipped & supported",
      items: [
        "Data layer + migrations",
        "Queue, cache, pub/sub",
        "Mail + mailing lists, webhooks",
        "Auth + RBAC",
        "Router, kernel, React SSR + islands",
        "Admin surface",
        "Browser → server tracing",
        "Content store / engine / CLI / MCP",
        "Cloudflare + Node deploy",
      ],
    },
    {
      pip: "bg-warn",
      label: "Preview — may change",
      items: [
        "Content search (to ~10k docs)",
        "Embeddings",
        "Prose / lint / SEO tooling",
        "Content components beyond HtmlContent",
        "AI primitives",
      ],
    },
    {
      pip: "bg-faint",
      label: "Deferred — post-1.0",
      items: [
        "Plugin / theme extensibility",
        "Crash-safe durable workflows",
        "Realtime over the wire",
        "A managed “Lesto Cloud”",
      ],
    },
  ] as const;
  return (
    <Section>
      <SectionHead eyebrow="Credibility over conversion" title="Exactly what is load-bearing today">
        Lesto is young and holds a strict bar. Here is what ships, what is preview, and what is
        deferred — if a docs page doesn’t say preview, it’s held to the full bar.
      </SectionHead>
      <div className="grid grid-cols-3 gap-px bg-line border border-line rounded-card overflow-hidden max-[760px]:grid-cols-1">
        {cols.map((col) => (
          <div className="px-[1.55rem] py-[1.6rem] bg-panel" key={col.label}>
            <h3 className="flex items-center gap-2 mb-4 text-[0.82rem] font-semibold tracking-[0.04em] uppercase text-muted">
              <span className={`w-[7px] h-[7px] rounded-full ${col.pip}`} /> {col.label}
            </h3>
            <ul className="list-none m-0 p-0">
              {col.items.map((it) => (
                <li
                  className="py-[0.34rem] text-[0.9rem] text-ink-2 tracking-[-0.01em] border-t border-line first:border-t-0"
                  key={it}
                >
                  {it}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Cta(): ReactElement {
  return (
    <div className="border-t border-line bg-bg-soft">
      <div className="max-w-[1080px] mx-auto px-7 py-22 text-center">
        <h2 className="text-[clamp(1.7rem,3.4vw,2.3rem)] tracking-[-0.034em] font-semibold mb-[0.85rem]">
          Own a coherent stack — and an agent that can drive it
        </h2>
        <p className="text-muted text-[1.08rem] mx-auto mb-[1.9rem] max-w-[34rem] tracking-[-0.012em]">
          The Quickstart scaffolds a real app — typed schema, a migration, an SSR page with a
          hydrated island, a JSON API, security on by default — running locally in about five
          minutes.
        </p>
        <div className="flex gap-[0.8rem] justify-center items-center flex-wrap">
          <a
            className={BTN_PRIMARY}
            href={`${DOCS_URL}/quickstart`}
            data-analytics="cta_quickstart"
          >
            Start the Quickstart <ArrowIcon />
          </a>
          <a className={BTN_GHOST} href="/use-cases" data-analytics="cta_use_cases">
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
