/**
 * The use-cases showcase at `/use-cases` — "what you can build", grounded only in
 * shipped reality. Styled with Tailwind utilities compiled by `@lesto/styles`.
 *
 * Every card maps to a real, runnable artifact: an app in the `examples/` gallery
 * (each example is a per-battery QA gate that must run locally and deploy), and/or a
 * blog deep-dive and the battery's docs page. Nothing here is an aspirational case
 * study — each link goes to code or prose that exists today.
 */

import type { ReactElement } from "react";

import { DOCS_URL, GITHUB_URL } from "../site";

/** A link off a use-case card. */
interface UseCaseLink {
  readonly label: string;
  readonly href: string;
}

/** One showcase entry: a thing you can build, the batteries it leans on, links. */
interface UseCase {
  readonly title: string;
  readonly desc: string;
  readonly batteries: string;
  readonly links: readonly UseCaseLink[];
}

const example = (name: string): string => `${GITHUB_URL}/tree/main/examples/${name}`;
const docs = (path: string): string => `${DOCS_URL}${path}`;

const USE_CASES: readonly UseCase[] = [
  {
    title: "A marketing site + authed app on one origin",
    desc: "An auth-aware static marketing zone and a dynamic, signed-in app zone served from a single origin — the marketing header carries an island that resolves the current user on the client. (This very site is the static half.)",
    batteries: "Sites · Auth · Islands",
    links: [
      { label: "estate example ↗", href: example("estate") },
      { label: "Sites docs", href: docs("/batteries/sites") },
      { label: "Auth docs", href: docs("/batteries/auth") },
    ],
  },
  {
    title: "Background jobs with an operator dashboard",
    desc: "A durable, database-backed job queue — at-least-once delivery with exactly-once completion, retries, and batches with dependencies — plus a dashboard to watch it. No Redis, no broker: it runs on the SQL database you already have.",
    batteries: "Queue",
    links: [
      { label: "queue-dashboard example ↗", href: example("queue-dashboard") },
      { label: "Queue docs", href: docs("/batteries/queue") },
      { label: "Deep dive", href: "/blog/the-queue-runs-on-your-database" },
    ],
  },
  {
    title: "An admin panel over your data",
    desc: "A typed CRUD backbone over your tables — paginated lists, validation, a field allow-list, and an onMutation hook for auditing — the generic admin surface a WordPress-style back office sits on.",
    batteries: "Admin · Data",
    links: [
      { label: "admin example ↗", href: example("admin") },
      { label: "Admin docs", href: docs("/batteries/admin") },
    ],
  },
  {
    title: "A newsletter with double opt-in",
    desc: "The full double-opt-in subscriber journey and broadcasts over transport-agnostic transactional mail — the Ghost-style mailing-list battery, wired end to end as real HTTP routes.",
    batteries: "Mailing lists · Email",
    links: [
      { label: "mailing-lists example ↗", href: example("mailing-lists") },
      { label: "Mailing lists docs", href: docs("/batteries/mailing-lists") },
    ],
  },
  {
    title: "A content-driven site or blog",
    desc: "Schema-driven content collections rendered from Markdown/MDX at build time, prerendered to static HTML on the edge. The blog and changelog you are reading are exactly this.",
    batteries: "Content engine",
    links: [
      { label: "blog example ↗", href: example("blog") },
      { label: "Why Lesto", href: docs("/why-lesto") },
    ],
  },
  {
    title: "End-to-end tracing, browser to database",
    desc: "One distributed trace that spans the browser click → the API handler → the database query — the thing most JS stacks leave you to assemble — built in, exported over OTLP, with no OpenTelemetry dependency.",
    batteries: "Observability",
    links: [
      { label: "Observability docs", href: docs("/batteries/observability") },
      { label: "Deep dive", href: "/blog/one-trace-from-the-browser-to-the-database" },
    ],
  },
  {
    title: "An app an agent can operate",
    desc: "Expose your app's operations to the Lesto MCP server and drive the running app from Claude or ChatGPT — publish and edit content, generate UI, inspect routes — read-only by default, destructive actions gated, every action audited.",
    batteries: "MCP · Content · UI",
    links: [
      { label: "MCP docs", href: docs("/batteries/mcp") },
      { label: "Deep dive", href: "/blog/let-an-agent-drive-your-app" },
    ],
  },
];

/** The showcase page: a header, then one card per use case. */
export function UseCasesPage(): ReactElement {
  return (
    <main className="max-w-[1080px] mx-auto px-7 py-[6.5rem]">
      <div className="max-w-[40rem] mx-auto text-center mb-12">
        <span className="block text-[0.78rem] font-semibold tracking-[0.02em] text-accent-ink mb-[0.9rem]">
          Use cases
        </span>
        <h1 className="text-[clamp(1.7rem,3.4vw,2.3rem)] leading-[1.12] tracking-[-0.032em] font-semibold mb-[0.9rem] text-ink">
          What you can build with Lesto
        </h1>
        <p className="text-[1.08rem] leading-[1.55] text-muted tracking-[-0.012em]">
          Every example here is real and runnable — an app in the gallery, a deep-dive, or a
          battery's docs. Each gallery app is a QA gate that must run locally and deploy before the
          feature counts as done.
        </p>
      </div>
      <div className="grid grid-cols-3 gap-4 max-[820px]:grid-cols-2 max-[540px]:grid-cols-1">
        {USE_CASES.map((uc) => (
          <div
            className="flex flex-col px-[1.55rem] py-6 border border-line rounded-card bg-panel transition-all hover:border-accent-line hover:-translate-y-[3px] hover:[background:radial-gradient(110%_90%_at_50%_-10%,color-mix(in_srgb,var(--accent)_7%,var(--panel)),var(--panel)_70%)] hover:shadow-[0_18px_40px_-24px_color-mix(in_srgb,var(--accent)_45%,transparent)]"
            key={uc.title}
          >
            <h3 className="flex items-center gap-[0.6rem] mb-[0.55rem] text-[0.98rem] font-semibold tracking-[-0.015em] text-ink">
              {uc.title}
            </h3>
            <p className="m-0 flex-1 text-[0.9rem] leading-[1.55] text-muted tracking-[-0.008em]">
              {uc.desc}
            </p>
            <p className="mt-[0.9rem] mb-[0.55rem] text-[0.74rem] font-semibold tracking-[0.03em] uppercase text-accent-ink">
              {uc.batteries}
            </p>
            <p className="m-0 text-[0.86rem] tracking-[-0.01em] [&_a]:text-ink-2 [&_a]:font-medium [&_a:hover]:text-accent">
              {uc.links.map((link, i) => (
                <span key={link.href}>
                  {i > 0 ? <span className="text-faint"> · </span> : null}
                  <a href={link.href}>{link.label}</a>
                </span>
              ))}
            </p>
          </div>
        ))}
      </div>
    </main>
  );
}

/** Bind the showcase into a zero-prop page component for static registration. */
export function makeUseCases(): () => ReactElement {
  return function BoundUseCases(): ReactElement {
    return <UseCasesPage />;
  };
}
