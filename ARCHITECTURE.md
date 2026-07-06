# Lesto — Architecture & Product Vision

> **Lesto is a batteries-included, AI-native, fullstack JavaScript framework.** It gives the JS ecosystem first-class, *in-house* solutions for the "hard parts" that Rails, Laravel, and WordPress ship in the box and Next.js leaves you to assemble: ORM + migrations, jobs/queues, durable workflows, caching, pub/sub, transactional email, mailing lists, users & auth, roles/permissions/RBAC, webhooks, crons, content management, an admin UI — plus observability and agent control built in, and a post-1.0 extensibility model (hooks/plugins/themes).
>
> **Honesty note (v1):** the extensibility model is a *designed, deferred* bet, not a shipped battery — see [ADR 0014](./docs/adr/0014-plugin-system.md). The earlier `@lesto/hooks`/`@lesto/config` prototypes were orphans (zero importers) and were removed from the v1 surface; §3.5, §4, and §8 below describe the eventual shape, not current code.
>
> Best of **Rails** (conventions, ORM, generators, **Solid-trifecta-on-the-DB**) + **Laravel** (in-house batteries: queues, mail, cache, events) + **WordPress** (content, admin, and the **actions/filters/plugins/themes** that let anyone build anything onto the platform) + **Next.js** (React, SSR, file routing, DX). Forward nods to **Ghost** (memberships/newsletters), **Webflow** (visual builder), **Carrd** (dead-simple sites), **Supabase** (Postgres-as-the-platform).

The north star: **change your site — content, UI, schema, data — and deploy it, from an MCP integration inside Claude/ChatGPT desktop.** The CLI and the visual UI are alternative surfaces over the same operations; neither is required.

---

## 1. Principles

1. **One substrate: the SQL database. In-house, world-class batteries on top.** The batteries (queue, cache, pub/sub, workflows, auth, search) are *owned* Lesto APIs built on **the one database** — SQLite for zero-config local + small prod (Rails-8 style), **Postgres** as the scale substrate (Supabase style). We do **not** glue a zoo of external services. The framework's identity is its coherent, in-house developer experience — not an adapter sprawl.
2. **Own the API and the extensibility model; keep a driver seam underneath.** Lead with pure Postgres; but design `cache`/`queue`/etc. so a specialized store (e.g. Redis) can slot **under the same API** at scale, without app-code changes. Coherence by default, escape hatch when earned.
3. **Thin drivers only at the irreducible edges.** A few things genuinely cannot live in the DB: **email delivery** (SMTP/SES/Resend), **object storage** (S3/local), **OAuth providers**. These stay thin, pluggable *send/transport* drivers behind in-house APIs. Everything else is in-house on the DB.
4. **Extensibility is a first-class primitive.** Hooks/actions/filters (WordPress) + events/listeners (Laravel) + a plugin & theme model (Loom). This is what makes Lesto a *platform you build anything onto*, not just a framework. See §3.5.
5. **One operations layer, three equal surfaces: MCP · UI · CLI.** Every capability is an *operation* in a single core layer; CLI, Studio UI, and the **Lesto MCP server** are thin front-ends. This is what makes "agent-first, CLI/UI optional" real.
6. **Zero-config local → scale substrate for prod.** `lesto new` runs on nothing — embedded SQLite, DB-backed queue/cache, dev mail-catcher. Move to Postgres (+ optional edge drivers) for scale; the in-house APIs never change.
7. **Stateless web tier; state lives in the one DB** — what makes deploys safe (§6).

---

## 2. Infrastructure stance (do we ship infra?)

**No — and now we barely need to.** By consolidating on the database, "production infra" collapses to **one Postgres** (plus the irreducible edges: a mail-send transport, object storage, OAuth apps). Precedents: **Rails 8 Solid Queue/Cache/Cable** (no Redis), **Supabase** (Postgres for DB/auth/storage/realtime/queues/cron/vector).

- **Local dev needs nothing** — SQLite + DB queue/cache + mail-catcher.
- **Production = one Postgres** + thin edge drivers; optionally a Redis driver later for extreme throughput, behind the same API.
- **One `SqlDatabase` surface, four substrate drivers — the tier picks one, the app never changes.** Node: `openPostgres` over `pg` (`@lesto/pg`) at scale, `openSqlite` in dev. Cloudflare Workers (no filesystem, no node sockets): `d1ToSqlDatabase` over D1 (the edge's SQLite) or `hyperdriveToSqlDatabase` over **Cloudflare Hyperdrive** (the edge's Postgres — pooled, connection-cached, fronting a real Postgres), both in `@lesto/cloudflare`. Same async `SqlDatabase` seam, same `?`→`$n` dialect (shared with `@lesto/pg`), so a DB-driven page runs the identical query path on every tier.
- **Managed "Lesto Cloud" is a later commercial layer** that one-click-provisions Postgres + edges — the Vercel→Next / Forge→Laravel / .com→.org model.

---

## 3. The three pillars

| Pillar | Role (best-of) | Status |
|---|---|---|
| **Tracks** (`/`) | Rails/Laravel **backend** — ActiveRecord ORM, migrations, router, controllers, generators, CLI | Built (33 tests). SQLite today; **Postgres adapter = the scale substrate, to add** |
| **Loom** (`/loom`) | Next-like **frontend + theme engine** — React, Vite 6 SSR + hydration; AI-native UI rendering (UI-tree → React against a vetted registry) | Built (13 tests). Registry to re-base on **shadcn** |
| **Docks** (folding in from owned repo `rdimascio/downto`, `@usedocks/*`) | WordPress-like **content/CMS** — schema-driven collections, markdown/MDX, embeddings + vector search, an **MCP server**, and **Studio** (mature visual editor: React + CodeMirror + Hono, git-backed publish, Anthropic chat) | **v1 supported surface = the store/engine/CLI/MCP seam** (`@lesto/content-store`, `@lesto/content-core`, `lesto content:build`, the `@lesto/mcp` content tools, `HtmlContent`). The rest of the folded-in estate — search, embeddings, prose, lint, seo, query, vite, components beyond `HtmlContent` — ships **PREVIEW** (experimental, coverage-gate-exempt). Search is brute-force O(n), practical to ~10k docs; embeddings download a ~25MB model on a cold build. Consolidation to ~7 packages is post-1.0. |

`loom/lesto-server.js` is the working prototype of the unified runtime: **Tracks ORM query → Loom UI tree → SSR'd hydrated React**, plus a JSON API route. The Rails⋈Next spine, proven.

## 3.4 Local dev & DB lifecycle (first-class — the substrate's operations)

Because the database *is* the platform, its dev/ops lifecycle is foundational, not an afterthought. Owned, in-house, zero-config-local:

- **Migrations** — schema *and* data (a migration's `up()` runs arbitrary SQL/data transforms). `tracks db:migrate` / `db:rollback` / `db:status`. ✅ built.
- **Seeding** — idempotent `db/seeds.js` with `findOrCreate`/`upsert` helpers; `tracks db:seed`. ✅ built.
- **Reset** — `tracks db:reset` drops → migrates → seeds for a clean local slate. ✅ built.
- **Transactional testing** — each test runs in a SAVEPOINT that rolls back; one migrated DB, no teardown, fast + isolated (`testing.transaction`). ✅ built.
- **Data masking** — deterministic, referentially-stable maskers (email/name/phone/redact/hash) to pull prod data locally with PII masked; `db/masking.js` config + `tracks db:mask`. ✅ built.
- Zero-config local: embedded SQLite, in-DB queue/cache, dev mail-catcher; same APIs over Postgres in prod.

## 3.5 The extensibility system (the WordPress lesson — in-house) — *post-1.0, deferred (ADR 0014)*

> **Status:** not built in v1. The `@lesto/hooks`/`@lesto/config` prototypes were
> removed as orphans; this is the eventual shape, designed against real consumers
> post-1.0 ([ADR 0014](./docs/adr/0014-plugin-system.md)), not a current API.

The thing no JS meta-framework has, and the reason WP/Rails/Laravel are platforms:

- **Hooks: actions & filters** (WordPress) — `addAction('post.published', fn)`, `applyFilter('render.tree', tree)`. Synchronous extension points the framework fires throughout its lifecycle.
- **Events & listeners** (Laravel) — domain events (`UserRegistered`) with async listeners that run as jobs.
- **Plugins** — installable packages that register hooks, models, routes, jobs, admin panels, MCP tools, and Loom components.
- **Themes/templates** — Loom *is* the theme engine; a theme is a set of Loom templates binding content → components.

When built (post-1.0), this lives in-house on the one substrate and is exposed equally to code, plugins, and **agents** (an agent can register/trigger hooks via MCP). It is not yet wired in v1.

---

## 4. The hard-parts surface

Each capability = an in-house Lesto API on the one DB; thin drivers only at the edges.

> **Status column refreshed 2026-07-05.** The earlier revision of this table was the
> original plan (it still named pre-Lesto choices like better-auth and the Tracks/Docks
> prototypes) and read "◻ build" long after the batteries shipped — which silently broke
> `docs/brand/messaging.md`'s claims guardrail, whose source of truth this is. Live
> inventory: `packages/*` and docs.lesto.run/batteries. ✅ = shipped to the full bar;
> ◐ = shipped but preview-labeled (claim per the guardrail).

| Capability | Substrate (default) | Lesto API | Status |
|---|---|---|---|
| DB / ORM / migrations | SQLite → **Postgres** | `@lesto/db` (`defineTable`, typed queries, joins/FKs) + `@lesto/migrate` | ✅ shipped (SQLite + Postgres; joins/FKs — ADR 0018; eager-loading `relations()` deferred per ADR 0018) |
| Virtual tables / views | SQL views + computed fields | view-backed models, computed fields | ◻ build |
| **Jobs / queue** | **Postgres `SKIP LOCKED`** (Solid-Queue-style); SQLite local | `@lesto/queue` — `define` / `enqueue` / `work` | ✅ shipped (the reference-implementation package) |
| Durable **workflows** | in-house on the one DB | `@lesto/workflows` — steps with resumable memoization | ✅ shipped (step memoization; automatic crash-resume is post-1.0 — claim per the guardrail) |
| **Crons** / scheduled | repeatable jobs on the DB queue | `@lesto/queue` scheduler | ✅ shipped |
| **Webhooks** | the DB queue (delivery + retries) | `@lesto/webhooks` — outbound HMAC + retries; inbound verify | ✅ shipped |
| **Caching** | in-memory + **DB-backed** (Solid-Cache-style) | `@lesto/cache` | ✅ shipped |
| **Pub/sub / realtime** | Postgres **`LISTEN/NOTIFY`**; **logical replication** for sync | `@lesto/pubsub` + `@lesto/realtime` (topic invalidation → SSE, live `useQuery`); Tier-4 local-first sync in `@lesto/live*` (ADR 0042) | ✅ shipped (realtime); ◐ Tier-4 sync v1 shipped, hardening open — claim per the guardrail |
| **Email** | in-house mailer; transport = **SMTP/provider** drivers | `@lesto/mail` — typed templates → HTML, queued sends | ✅ shipped |
| **Mailing lists** | DB models + mailer + queue | `@lesto/mailing-lists` — subscribers, double opt-in, broadcasts | ✅ shipped |
| **Users & auth** | in-house **`@lesto/identity`** over the DB | register / verify / login / reset, sessions | ✅ shipped (in-house — not better-auth; OAuth AS for MCP in `@lesto/oauth-server`, interim per ADR 0039) |
| **Roles / perms / RBAC** | DB + policy layer | `@lesto/authz` — principals, roles, guards | ✅ shipped |
| **Content management** | `@lesto/content-*`, DB-backed via `@lesto/db` | collections, markdown/MDX, store, admin, MCP | ✅ shipped (search/embeddings/prose components ◐ preview) |
| **Search** | Postgres **FTS + `pgvector`** planned | `@lesto/content-search` / `-embeddings` | ◐ preview |
| **UI components** | **Tailwind v4 + shadcn/ui**, first-class | scaffold is a generic shadcn project; `lesto add <component>` | ✅ shipped (ADR 0037) |
| **Forms** | over `@lesto/ui`, built-in validator | `@lesto/forms` — schema-driven forms, validate → action | ✅ shipped |
| **Extensibility** | in-house (§3.5) | hooks/actions/filters, events, plugins, themes | ◻ deferred post-1.0 (ADR 0014) |
| **Observability** | in-house tracing, OTLP export | `@lesto/observability` — **one trace browser → API → DB**, RUM, `ai.*` agent spans (ADR 0031) | ✅ shipped (the differentiator — safe to claim) |
| **Deploys** | static assets + Worker, one atomic step | `lesto deploy --cloudflare` | ✅ shipped (Cloudflare flagship; other targets via the deploy seam) |
| **Object storage** | local FS → **S3-compatible** | `@lesto/storage` — `put`/`get`, S3 backend | ✅ shipped |

---

## 5. Jobs vs. Workflows — the decision (revised: on the one DB)

Two layers, both on Postgres; the queue is always-on, workflows opt in.

- **Queue (foundation, always-on) — built in-house on the DB.** Durable job queue via `SELECT … FOR UPDATE SKIP LOCKED` + visibility-timeout reclaim (the Rails-8 Solid Queue / `pgmq` pattern — a well-understood ~few-hundred-line primitive, *not* reinventing Temporal). Owned API (`defineJob`), zero infra, idempotent-by-convention. A Redis/BullMQ driver can slot under the same API for extreme throughput later.
- **Durable workflows (first-class, opt-in) — on the same DB.** Multi-step, crash-surviving orchestration (`sleep`, `waitForEvent`, sagas) for drip/newsletter sequences, multi-step deploys, and long-running agent ops. **Build a thin in-house layer on the DB, or adopt [DBOS](https://github.com/dbos-inc/dbos-transact-ts)** (PG-native durable workflows+queues as a library — the cleanest "adopt" option that stays on our substrate). Decide build-vs-DBOS at that slice. **Shipped today (`@lesto/workflows`):** the step-memoization half only — completed steps journal to the DB and replay when `run()` is re-invoked with the same `runId` (caller-driven resume). The *crash-safe* half — a run journal, a queue-backed resume driver that re-invokes workflows automatically after a crash, durable `sleep`, and `waitForEvent` — is post-1.0.
- **Demoted to optional adapter:** Vercel `workflow` (confirmed self-hostable, Apache-2.0, good — but brings its own store model rather than living on our one DB), Inngest, Temporal, Trigger.dev.

**Why on the DB, not Redis-first:** coherence (one substrate humans + agents reason about), zero-ops local + small prod, and it's where Rails/Supabase are converging. Keep the driver seam for scale.

---

## 6. Deployment & durability model

State lives in the one DB → **web tier stateless** → zero-downtime **rolling restarts** (no Redis, no sticky sessions). The DB queue is durable (**at-least-once + visibility-timeout reclaim**); workers **graceful-drain on SIGTERM**; a worker killed mid-job (a deploy) releases the job, which is reclaimed and re-run. Jobs idempotent by convention; workflows give exactly-once *effects* via checkpointing. Deploy tooling: Kamal-style rolling deploy is the model.

**Per-tier durability substrate.** On the Node tier the durable store is one Postgres reached over `openPostgres` (`@lesto/pg`, a node-postgres `Pool`). On the Cloudflare Workers tier — where there is no filesystem and no node socket — the same durable data is reached over `hyperdriveToSqlDatabase` (Cloudflare Hyperdrive fronting a real Postgres, with edge-side pooling + connection caching), or `d1ToSqlDatabase` for D1's edge SQLite where Postgres scale is not needed. All three satisfy the identical async `SqlDatabase` surface, so "SQLite local → Postgres at scale, same APIs" holds on the flagship edge tier, not only on Node. The Hyperdrive driver bundles for Workers with zero `node:*` builtins; a live binding needs a publicly-reachable Postgres, a `wrangler hyperdrive create` config, and a token with the `hyperdrive` scope.

---

## 7. Observability (a deliberate differentiator)

OpenTelemetry-first, auto-instrumented: **one trace spans UI → API/controller → DB query** (browser spans stitch to the server trace — the thing no JS meta-framework ships), structured logs, profiling, queue/workflow spans. Exporters: Datadog, Honeycomb, Grafana/Tempo, any OTLP.

**Browser→server stitching is shipped, not aspirational.** The server stamps the in-flight request span's W3C `traceparent` into a `<meta name="lesto-traceparent">` on every dynamically rendered page; `@lesto/observability`'s browser RUM client (`startBrowserRum`, imported by the synthesized `@lesto/assets` client entry from the node-free `@lesto/observability/rum` subpath) reads it, **adopts the server trace id**, and emits browser spans for navigation timing, same-origin resource fetches, and web vitals (LCP, INP, and raw per-shift `layout-shift` scores — not a summed CLS) — PII-free (same-origin paths + timing numbers only) and bounded-sampled. Those spans POST to the built-in `POST /__lesto/browser-spans` receiver (`@lesto/web`), which routes them through `traces.seams.onBrowserSpan` to the **same OTLP exporter** the server spans use, so a page load's browser spans land **under the server `http.request` span, one traceId**. Outbound `@lesto/client` data fetches carry a `traceparent` (`wrapFetch`) on same-origin requests, so the API handler joins the same trace — UI → API → DB, unbroken. Proven end-to-end in `packages/integration/test/rum.integration.test.ts` against a local OTLP collector.

**The trace reaches the agent tier, too (PREVIEW).** When a request calls the preview `@lesto/ai` — `generateText` for one model call, `runAgent` for a bounded tool loop — each model call becomes an `ai.generate` span and each tool run an `ai.tool` span, carrying the model id, token usage, and stop reason as **attributes**. `@lesto/ai` takes no `@lesto/observability` dependency: it accepts an injected `AgentTracer`, and the app adapts its `Tracer` to it, parenting each span on the in-flight `http.request` span — so **one HTTP request that calls an LLM produces `http.request → ai.generate → ai.tool` on one traceId**, agent and LLM calls on the same trace as the request that drove them. The `examples/estate` concierge (`POST /mls/api/assistant`) is the dogfood — its node serve path (with `LESTO_OTLP_URL` set) emits the join, asserted in `examples/estate/test/ai-trace.dogfood.test.ts`. The token counts are span attributes, **not** a metrics/cost pipeline, and there is no queryable span store — spans go to your OTLP collector like every other. The **MCP** control-plane path is separate: a governed `mcp.tool` action can emit a span, but it is **standalone** (stdio dispatch runs outside any HTTP request); joining it to a request trace is a deferred, unshipped seam, so Lesto does **not** claim MCP activity rides the request trace today.

---

## 8. Build order (dependency-aware)

1. ✅ **Queue + scheduler** (in-house, SQLite atomic-claim now / Postgres `SKIP LOCKED` next) with graceful-drain + reclaim — **built**; the reclaim mechanism (a worker that drops a job mid-flight releases it for another worker to claim and complete, no loss) is covered in `packages/queue/test/queue.test.ts`. Plus the DB lifecycle (§3.4): seeding, transactional testing, masking — all built & tested. *(Note: the **scheduler** dedupes cron firings in in-process memory — run exactly one scheduler instance per deployment; see `packages/queue/src/scheduler.ts`.)*
2. **Hooks / events / plugins** extensibility core (§3.5) — everything else registers through it. ← **deferred post-1.0** (ADR 0014; the orphan prototypes were removed from the v1 surface).
3. **Auth + users + RBAC** (in-house `@lesto/identity` + `@lesto/authz` over the DB — shipped; this §8 build-order note predates them).
4. **Mailers** (react-email) **+ webhooks** — on the queue.
5. **shadcn-based Loom registry + Forms.**
6. **Cache · pub/sub (LISTEN/NOTIFY) · mailing lists · virtual tables.**
7. **Workflows** (in-house or DBOS) for drip/deploy/agent flows.
8. **Docks content on Tracks + Studio as admin; OTel; Lesto MCP server (the unifying operations surface).**

---

## 9. Open questions to resolve

- **Postgres vs SQLite default for `lesto new`** — SQLite for true zero-config (Rails-8 stance), Postgres the moment you need pub/sub-realtime, pgvector, or scale. Likely: SQLite local, Postgres prod, one API over both.
- **In-house workflow layer vs DBOS** — decide at the workflow slice; both stay on the one DB.
- ~~**better-auth ↔ Tracks**~~ — RESOLVED: auth shipped in-house as `@lesto/identity` (not better-auth), owning its own schema via `@lesto/migrate`.
- **Tailwind in Loom** — required for shadcn; confirm SSR + AI-tree registry still validate cleanly.
- **Hook system shape** — sync actions/filters (WP) vs. async events/listeners (Laravel): ship both, clarify when each fires.
- **Managed Lesto Cloud** — scope/timing of the commercial layer.
