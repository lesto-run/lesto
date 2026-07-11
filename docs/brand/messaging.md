# Lesto — Messaging & Voice (v0)

The single source of truth for how we talk about Lesto in public. Owned by DevRel.
Every launch surface — README, docs, landing page, social, talks — pulls from here
so the story stays consistent and, above all, **honest**.

> Status: v1, refreshed 2026-07-05 (post-publish, post-Tier-4) — the v0 draft predated
> the npm publish, the shipped Tier-4 sync epic, and the dev-MCP/agent-on-ramp work, and
> its guardrail had gone stale in both directions. The tagline is LOCKED (§2 #1, shipped
> on every surface). The claims guardrail (§5) is binding; every launch artifact is
> claims-reviewed against THIS revision.

---

## 1. The name

**Lesto** — Italian for *quick, nimble, light on its feet*. Pronounced "LEH-stoh".
Lowercase in prose and code (`lesto()`, `lesto` CLI, `@lesto/*`). The journey here
was Keel → Volo → Lesto; only the final name ships. Don't reference the old names
publicly.

## 2. Tagline finalists

Pick one hero line and stick to it everywhere. Finalists, in recommended order:

1. **"Batteries-included. Agent-native."** — *(recommended)* Two words do the whole
   job: the Rails/Laravel promise plus the one thing no incumbent has. Short enough
   for an OG image, a nav bar, and a tweet. This is what the shipped `og.svg` uses.
2. **"The full-stack TypeScript framework you can drive from Claude."** — One
   sentence, leads with the wedge. Best as the sub-hero line under #1.
3. **"The framework agents can drive."** — Punchiest, but undersells the
   batteries-included half that does most of the day-one work.

**Hero stack we ship today** (landing + OG image):

> # Batteries-included. Agent-native.
> The full-stack TypeScript framework you can drive from Claude, the CLI, or code.

## 3. Elevator pitches (three lengths)

- **One line:** Lesto is the batteries-included, agent-native, full-stack TypeScript
  framework.
- **One paragraph:** Lesto gives TypeScript the in-house "hard parts" Rails and
  Laravel ship in the box — ORM, queues, workflows, cache, auth, email, admin,
  content, observability — built on one substrate, the SQL database (SQLite local,
  Postgres at scale), with React SSR on the frontend and Cloudflare-edge deploys.
  The twist no incumbent has: every capability is an operation you can drive from an
  MCP client inside Claude or ChatGPT, not just your editor.
- **The wedge, alone:** Change your app's content, UI, schema, and data — and ship
  it — by asking your agent. The CLI and the visual UI are alternative surfaces over
  the same operations; neither is required.

## 4. Voice & tone

- **Honest over hype.** We name what's preview and what's deferred. Credibility is
  the asset; one overclaim a skeptical HN reader catches costs more than ten
  features. (See §5.)
- **Concrete over abstract.** Show the `npm create lesto` → running-app path, the
  real query, the real trace. Code samples are complete and runnable, not snippets.
- **Architectural, not breathless.** Explain the *why* (one substrate, no service
  zoo) before the *what*. Assume a competent TypeScript reader; don't condescend.
- **Confident, not contemptuous.** We respect Next.js, Rails, Laravel, Supabase — we
  borrow their best ideas openly. Never punch down at the tools people use today.
- **Plain words.** No "blazing-fast", "revolutionary", "game-changing", "10x".

## 5. The claims guardrail (binding)

External copy must match shipped reality. Use this table; when in doubt, downgrade
the claim. ARCHITECTURE.md §4 is the internal source of truth for status (its status
column was refreshed 2026-07-05 — earlier revisions read "◻ build" on long-shipped
batteries; if it ever contradicts `packages/*` reality again, fix it before writing copy).

| Claim | How we may say it |
|---|---|
| ORM / data layer | "Typed schema, migrations, relational queries with joins." **Not** "a full ActiveRecord-class ORM" — eager-loading/`relations()` is partial. |
| Queue / cache / pub-sub / mail / auth / RBAC / webhooks / admin | Say it plainly — **shipped and supported.** |
| Browser→server tracing | "One trace spans browser → API → DB" — **shipped**, proven in the integration suite. Safe to claim. |
| Workflows | "Resumable step memoization." **Not** "durable, crash-safe workflows" — automatic resume-after-crash is post-1.0. |
| Content / CMS | "A content engine: schema-driven collections, markdown/MDX, store + CLI + MCP." Search/embeddings/prose/seo tooling and most components are **preview** — label them. **No** "visual CMS / Studio editor" claim; it isn't in the v1 surface. |
| Plugins / themes / extensibility | **Do not claim.** Designed but deferred post-1.0 (ADR 0014). May say "an extensibility model is on the roadmap." |
| Realtime / reactive live queries | **Shipped — claim precisely.** Server-pushed invalidation drives live `useQuery`: a write publishes an invalidation *topic* (a key string, **never row data**) over Postgres `LISTEN/NOTIFY`, fanned out to the browser over SSE; subscribers drop the key and refetch through the authorized endpoint. Say "reactive data / live queries." **Not** "we stream your data to the browser" (the wire carries topics, not rows) and **not** "local-first / offline" (that's the next row). DB-backed pub/sub also ships. |
| Local-first / sync engine (`live()`) | **Tier-4 v1 shipped (ADR 0042) — claim it as "v1, in hardening", not as unqualified production offline sync.** Shipped and CI-gated end-to-end (the `examples/live-capstone` gate): Postgres **logical replication** (and a SQLite poll behind the same fail-closed `live()` seam), LSN-exact resume, a **durable OPFS-SQLite store** (Worker-hosted), an **offline write outbox**, and cross-tab leadership. May say: "local-first sync, v1: logical replication to a durable local store with offline writes — in active hardening," and may demo the capstone. **Upgrade to an unqualified "local-first / offline" headline only when ALL of:** (a) per-row sync authorization is enforced and tested, (b) the open hardening list (cross-tab + replica-identity tasks on the board) is closed **and frozen as of the GA cut**, (c) the capstone is green across real browsers beyond the CI-gated path, (d) **a fully-offline reload serves the app shell** (an app-shell-precache service worker — GA scope per the 2026-07-10 ruling; distinct from the rejected SW *sync engine*). Until then, no "production-ready offline sync" and no "we sync any query offline." **Positioning (say it first, in our words):** the sync engine runs as **one long-lived process beside your Postgres** — a logical-replication slot is a single-consumer resource *in Postgres itself*, the same shape every replication-based sync engine (Electric, PowerSync) has; your **app tier stays stateless and edge-deployable**, the sync tier is data infrastructure like the database. Edge fan-out (Durable Objects holding shapes) is a stated **vNext, not shipped** — do **not** imply "serverless sync" or "sync at the edge." |
| "Lesto Cloud" / managed hosting | **Do not claim.** Future commercial layer, unscoped. |
| Agent / MCP control plane | **The wedge — claim it confidently, but precisely.** Shipped today: (1) the **governed app control plane** — content CRUD/query, `generate_ui` (**preview** — backed by `@lesto/ui-generate`, present only when an Anthropic key + a component registry are configured, omitted otherwise), `list_routes`/`handle_request`/`describe_app`, read-only by default with destructive tools (content writes, `handle_request`) gated behind an explicit, audited operator mode; (2) the **dev-loop MCP** — every `lesto dev` boots a loopback, token-gated MCP server (`describe_app`, dev diagnostics, request/log tails — ADR 0032), proven nightly on the published closure by the agent-activation CI gate; (3) **app-defined domain tools** with per-tool policy floors (ADR 0043); (4) apps can ship an **authenticated production MCP server** (OAuth — interim issuer per ADR 0039; say "OAuth-protected", don't over-specify the issuer). **Schema migrations are still NOT an MCP tool** (CLI/code only) — do not imply "migrate the schema from Claude." The scaffold's agent on-ramp (AGENTS.md + Claude Code skill in every generated app) is on HEAD — **claimable only once the next create-lesto version publishes.** Say "operate your app — content, UI, requests, the dev loop — from Claude/ChatGPT." |
| Tailwind / shadcn UI | **Shipped — safe to claim (ADR 0037).** Tailwind v4 is first-class (`@lesto/styles` compiles the app's CSS entry); every scaffold is a generic shadcn project (`components.json`, `cn()`, `@/*` alias) so `npx shadcn add <component>` installs components. **Not** `lesto add <component>` — that's the deferred TW8; today `lesto add` takes integrations only. |
| Dev loop / DX | **Shipped — safe to claim.** Dev error overlay, typed validated env (`@lesto/env`, server/client leak boundary), island Fast Refresh, Vite dev+prod as default. |
| Agent-readable docs | **Shipped — safe to claim.** docs.lesto.run serves `llms.txt` + `llms-full.txt` and a Markdown twin of every page (path + `.md`). |

Rule of thumb: if a docs page or package README doesn't tag something "preview", it's
held to the full bar and you may claim it. If it's tagged preview or deferred, mark
it as such in public copy too.

## 6. Positioning one-liners (per competitor)

- **vs. Next.js:** "Keep React and SSR; stop assembling the backend from a zoo of
  vendors."
- **vs. Rails / Laravel:** "The same batteries, in strict TypeScript, edge-deployable."
- **vs. Supabase:** "Postgres-as-the-platform, but from the framework down — app,
  batteries, and the agent surface are one coherent thing."
- **vs. WordPress:** "The content + admin + extensibility model, rebuilt on a typed
  substrate." (Mind the extensibility guardrail.)

## 7. Brand assets

- **Mark:** the indigo rounded-square "L" (`#4f46e5`), as in the favicon and
  `site/src/og.ts`. Wordmark is "Lesto" in a system sans, weight 800.
- **Social card:** shipped as `og.svg` (built by `site/build.ts`, referenced by
  every docs page's `og:image`/`twitter:image`). A 1200×630 **PNG export** of the
  same design is the remaining belt-and-suspenders asset for unfurlers that reject
  SVG (Twitter/iMessage) — tracked as the OG-image board task.
- **Colors:** indigo `#4f46e5` primary, `#3730a3` deep, `#c7d2fe`/`#e0e7ff` light
  accents on dark. Keep it restrained.

## 8. Do / Don't

- ✅ "Lesto runs the same app on a Node server and the Cloudflare edge."
- ✅ "No Redis — the queue, cache, and pub/sub live on the database."
- ✅ "Operate it from Claude over MCP."
- ✅ "Your dev server is an MCP server — `describe_app` from Claude Code, out of the box."
- ✅ "Reactive live queries: a write invalidates a topic, subscribers refetch over SSE — no polling."
- ✅ "Local-first sync, v1: Postgres logical replication to a durable local store, with offline writes — in active hardening."
- ✅ "lesto.live adds one process next to your database — not a new vendor, not a service zoo. Your app stays edge-deployable."
- ❌ "The fastest framework ever built." (unproven, and we don't talk like that)
- ❌ "Local-first sync at the edge" / "serverless sync engine." (The slot consumer is a deliberate single-writer singleton — see `examples/live-capstone/DEPLOY.md`; edge fan-out is deferred vNext.)
- ❌ "Production-ready offline sync" / "sync any query offline." (Tier-4 v1 is shipped but in hardening — per-row sync authz + the hardening list gate the unqualified claim; see §5)
- ❌ "A full visual CMS." (not shipped)
- ❌ "Durable, crash-proof workflows." (post-1.0)
- ❌ Any benchmark number we haven't actually measured and published.
