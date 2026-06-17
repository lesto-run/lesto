# Keel — Architecture & Product Vision

> **Keel is a batteries-included, AI-native, fullstack JavaScript framework.** It gives the JS ecosystem first-class, *in-house* solutions for the "hard parts" that Rails, Laravel, and WordPress ship in the box and Next.js leaves you to assemble: ORM + migrations, jobs/queues, durable workflows, caching, pub/sub, transactional email, mailing lists, users & auth, roles/permissions/RBAC, webhooks, crons, content management, an admin UI — plus observability and agent control built in, and a post-1.0 extensibility model (hooks/plugins/themes).
>
> **Honesty note (v1):** the extensibility model is a *designed, deferred* bet, not a shipped battery — see [ADR 0014](./docs/adr/0014-plugin-system.md). The earlier `@keel/hooks`/`@keel/config` prototypes were orphans (zero importers) and were removed from the v1 surface; §3.5, §4, and §8 below describe the eventual shape, not current code.
>
> Best of **Rails** (conventions, ORM, generators, **Solid-trifecta-on-the-DB**) + **Laravel** (in-house batteries: queues, mail, cache, events) + **WordPress** (content, admin, and the **actions/filters/plugins/themes** that let anyone build anything onto the platform) + **Next.js** (React, SSR, file routing, DX). Forward nods to **Ghost** (memberships/newsletters), **Webflow** (visual builder), **Carrd** (dead-simple sites), **Supabase** (Postgres-as-the-platform).

The north star: **change your site — content, UI, schema, data — and deploy it, from an MCP integration inside Claude/ChatGPT desktop.** The CLI and the visual UI are alternative surfaces over the same operations; neither is required.

---

## 1. Principles

1. **One substrate: the SQL database. In-house, world-class batteries on top.** The batteries (queue, cache, pub/sub, workflows, auth, search) are *owned* Keel APIs built on **the one database** — SQLite for zero-config local + small prod (Rails-8 style), **Postgres** as the scale substrate (Supabase style). We do **not** glue a zoo of external services. The framework's identity is its coherent, in-house developer experience — not an adapter sprawl.
2. **Own the API and the extensibility model; keep a driver seam underneath.** Lead with pure Postgres; but design `cache`/`queue`/etc. so a specialized store (e.g. Redis) can slot **under the same API** at scale, without app-code changes. Coherence by default, escape hatch when earned.
3. **Thin drivers only at the irreducible edges.** A few things genuinely cannot live in the DB: **email delivery** (SMTP/SES/Resend), **object storage** (S3/local), **OAuth providers**. These stay thin, pluggable *send/transport* drivers behind in-house APIs. Everything else is in-house on the DB.
4. **Extensibility is a first-class primitive.** Hooks/actions/filters (WordPress) + events/listeners (Laravel) + a plugin & theme model (Loom). This is what makes Keel a *platform you build anything onto*, not just a framework. See §3.5.
5. **One operations layer, three equal surfaces: MCP · UI · CLI.** Every capability is an *operation* in a single core layer; CLI, Studio UI, and the **Keel MCP server** are thin front-ends. This is what makes "agent-first, CLI/UI optional" real.
6. **Zero-config local → scale substrate for prod.** `keel new` runs on nothing — embedded SQLite, DB-backed queue/cache, dev mail-catcher. Move to Postgres (+ optional edge drivers) for scale; the in-house APIs never change.
7. **Stateless web tier; state lives in the one DB** — what makes deploys safe (§6).

---

## 2. Infrastructure stance (do we ship infra?)

**No — and now we barely need to.** By consolidating on the database, "production infra" collapses to **one Postgres** (plus the irreducible edges: a mail-send transport, object storage, OAuth apps). Precedents: **Rails 8 Solid Queue/Cache/Cable** (no Redis), **Supabase** (Postgres for DB/auth/storage/realtime/queues/cron/vector).

- **Local dev needs nothing** — SQLite + DB queue/cache + mail-catcher.
- **Production = one Postgres** + thin edge drivers; optionally a Redis driver later for extreme throughput, behind the same API.
- **Managed "Keel Cloud" is a later commercial layer** that one-click-provisions Postgres + edges — the Vercel→Next / Forge→Laravel / .com→.org model.

---

## 3. The three pillars

| Pillar | Role (best-of) | Status |
|---|---|---|
| **Tracks** (`/`) | Rails/Laravel **backend** — ActiveRecord ORM, migrations, router, controllers, generators, CLI | Built (33 tests). SQLite today; **Postgres adapter = the scale substrate, to add** |
| **Loom** (`/loom`) | Next-like **frontend + theme engine** — React, Vite 6 SSR + hydration; AI-native UI rendering (UI-tree → React against a vetted registry) | Built (13 tests). Registry to re-base on **shadcn** |
| **Docks** (folding in from owned repo `rdimascio/downto`, `@usedocks/*`) | WordPress-like **content/CMS** — schema-driven collections, markdown/MDX, embeddings + vector search, an **MCP server**, and **Studio** (mature visual editor: React + CodeMirror + Hono, git-backed publish, Anthropic chat) | **v1 supported surface = the store/engine/CLI/MCP seam** (`@keel/content-store`, `@keel/content-core`, `keel content:build`, the `@keel/mcp` content tools, `HtmlContent`). The rest of the folded-in estate — search, embeddings, prose, lint, seo, query, vite, components beyond `HtmlContent` — ships **PREVIEW** (experimental, coverage-gate-exempt). Search is brute-force O(n), practical to ~10k docs; embeddings download a ~25MB model on a cold build. Consolidation to ~7 packages is post-1.0. |

`loom/keel-server.js` is the working prototype of the unified runtime: **Tracks ORM query → Loom UI tree → SSR'd hydrated React**, plus a JSON API route. The Rails⋈Next spine, proven.

## 3.4 Local dev & DB lifecycle (first-class — the substrate's operations)

Because the database *is* the platform, its dev/ops lifecycle is foundational, not an afterthought. Owned, in-house, zero-config-local:

- **Migrations** — schema *and* data (a migration's `up()` runs arbitrary SQL/data transforms). `tracks db:migrate` / `db:rollback` / `db:status`. ✅ built.
- **Seeding** — idempotent `db/seeds.js` with `findOrCreate`/`upsert` helpers; `tracks db:seed`. ✅ built.
- **Reset** — `tracks db:reset` drops → migrates → seeds for a clean local slate. ✅ built.
- **Transactional testing** — each test runs in a SAVEPOINT that rolls back; one migrated DB, no teardown, fast + isolated (`testing.transaction`). ✅ built.
- **Data masking** — deterministic, referentially-stable maskers (email/name/phone/redact/hash) to pull prod data locally with PII masked; `db/masking.js` config + `tracks db:mask`. ✅ built.
- Zero-config local: embedded SQLite, in-DB queue/cache, dev mail-catcher; same APIs over Postgres in prod.

## 3.5 The extensibility system (the WordPress lesson — in-house) — *post-1.0, deferred (ADR 0014)*

> **Status:** not built in v1. The `@keel/hooks`/`@keel/config` prototypes were
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

Each capability = an in-house Keel API on the one DB; thin drivers only at the edges.

| Capability | Substrate (default) | Keel API | Status |
|---|---|---|---|
| DB / ORM / migrations | SQLite → **Postgres** | Tracks `Model`, migrations, query builder | ✅ built (SQLite) |
| Virtual tables / views | SQL views + computed fields | view-backed models, computed fields | ◻ build |
| **Jobs / queue** | **Postgres `SKIP LOCKED`** (Solid-Queue-style); SQLite local; Redis driver optional | `defineJob` / enqueue / worker | ◻ build (next) |
| Durable **workflows** | **Postgres** — in-house thin layer, or **DBOS** (PG-native) | `defineWorkflow` (`step`/`sleep`/`waitForEvent`) | ◻ build (engine on PG) — see §5 |
| **Crons** / scheduled | repeatable jobs on the DB queue (or `pg_cron`) | `schedule.cron(...)` | ◻ build |
| **Webhooks** | the DB queue (delivery + retries) | outbound HMAC + retries; inbound verify + event subs | ◻ build |
| **Caching** | in-memory + **DB-backed** (Solid-Cache-style); Redis driver optional | `cache.fetch(key, ttl, fn)` | ◻ build |
| **Pub/sub / realtime** | Postgres **`LISTEN/NOTIFY`** / logical replication (Supabase-style) | channels, subscriptions | ◻ build |
| **Email** | in-house mailer + **react-email** templates; transport = **SES/Resend/SMTP** (edge driver) | `defineMailer` — React + typed props → HTML, queued | ◻ build |
| **Mailing lists** | DB models + mailer + queue | Subscriber/List, double opt-in, segments, broadcasts | ◻ build (Ghost-style) |
| **Users & auth** | **better-auth** over the DB (sessions, OAuth, 2FA, orgs) | scaffolded auth | ◻ build |
| **Roles / perms / RBAC** | DB + better-auth plugins + policy layer | roles/permissions, `can?`, guards | ◻ build |
| **Content management** | Docks + Studio, DB-backed via Tracks | content types, admin, search, MCP | ✅ exists, ◻ integrate |
| **Search** | Postgres **FTS + `pgvector`** | full-text + semantic | ◻ (Docks has client vector search) |
| **UI components** | **shadcn/ui** (Radix + Tailwind) | Loom registry = shadcn | ◻ re-base Loom |
| **Forms** | shadcn + react-hook-form + zod | derive form from model/Zod → validate → action → ORM | ◻ build |
| **Extensibility** | in-house (§3.5) | hooks/actions/filters, events, plugins, themes | ◻ build (core) |
| **Observability** | **OpenTelemetry** + exporters | trace **UI → API → DB**, logs, profiling | ◻ build (differentiator) |
| **Deploys** | rolling / zero-downtime; graceful drain | `keel deploy` | ◻ build |
| **Object storage** | local FS → **S3** (edge driver) | `storage.put/get` | ◻ build |

---

## 5. Jobs vs. Workflows — the decision (revised: on the one DB)

Two layers, both on Postgres; the queue is always-on, workflows opt in.

- **Queue (foundation, always-on) — built in-house on the DB.** Durable job queue via `SELECT … FOR UPDATE SKIP LOCKED` + visibility-timeout reclaim (the Rails-8 Solid Queue / `pgmq` pattern — a well-understood ~few-hundred-line primitive, *not* reinventing Temporal). Owned API (`defineJob`), zero infra, idempotent-by-convention. A Redis/BullMQ driver can slot under the same API for extreme throughput later.
- **Durable workflows (first-class, opt-in) — on the same DB.** Multi-step, crash-surviving orchestration (`sleep`, `waitForEvent`, sagas) for drip/newsletter sequences, multi-step deploys, and long-running agent ops. **Build a thin in-house layer on the DB, or adopt [DBOS](https://github.com/dbos-inc/dbos-transact-ts)** (PG-native durable workflows+queues as a library — the cleanest "adopt" option that stays on our substrate). Decide build-vs-DBOS at that slice. **Shipped today (`@keel/workflows`):** the step-memoization half only — completed steps journal to the DB and replay when `run()` is re-invoked with the same `runId` (caller-driven resume). The *crash-safe* half — a run journal, a queue-backed resume driver that re-invokes workflows automatically after a crash, durable `sleep`, and `waitForEvent` — is post-1.0.
- **Demoted to optional adapter:** Vercel `workflow` (confirmed self-hostable, Apache-2.0, good — but brings its own store model rather than living on our one DB), Inngest, Temporal, Trigger.dev.

**Why on the DB, not Redis-first:** coherence (one substrate humans + agents reason about), zero-ops local + small prod, and it's where Rails/Supabase are converging. Keep the driver seam for scale.

---

## 6. Deployment & durability model

State lives in the one DB → **web tier stateless** → zero-downtime **rolling restarts** (no Redis, no sticky sessions). The DB queue is durable (**at-least-once + visibility-timeout reclaim**); workers **graceful-drain on SIGTERM**; a worker killed mid-job (a deploy) releases the job, which is reclaimed and re-run. Jobs idempotent by convention; workflows give exactly-once *effects* via checkpointing. Deploy tooling: Kamal-style rolling deploy is the model.

---

## 7. Observability (a deliberate differentiator)

OpenTelemetry-first, auto-instrumented: **one trace spans UI → API/controller → DB query** (browser spans stitch to the server trace — the thing no JS meta-framework ships), structured logs, profiling, queue/workflow spans. Exporters: Datadog, Honeycomb, Grafana/Tempo, any OTLP.

---

## 8. Build order (dependency-aware)

1. ✅ **Queue + scheduler** (in-house, SQLite atomic-claim now / Postgres `SKIP LOCKED` next) with graceful-drain + reclaim — **built**; the reclaim mechanism (a worker that drops a job mid-flight releases it for another worker to claim and complete, no loss) is covered in `packages/queue/test/queue.test.ts`. Plus the DB lifecycle (§3.4): seeding, transactional testing, masking — all built & tested. *(Note: the **scheduler** dedupes cron firings in in-process memory — run exactly one scheduler instance per deployment; see `packages/queue/src/scheduler.ts`.)*
2. **Hooks / events / plugins** extensibility core (§3.5) — everything else registers through it. ← **deferred post-1.0** (ADR 0014; the orphan prototypes were removed from the v1 surface).
3. **Auth + users + RBAC** (better-auth over the DB).
4. **Mailers** (react-email) **+ webhooks** — on the queue.
5. **shadcn-based Loom registry + Forms.**
6. **Cache · pub/sub (LISTEN/NOTIFY) · mailing lists · virtual tables.**
7. **Workflows** (in-house or DBOS) for drip/deploy/agent flows.
8. **Docks content on Tracks + Studio as admin; OTel; Keel MCP server (the unifying operations surface).**

---

## 9. Open questions to resolve

- **Postgres vs SQLite default for `keel new`** — SQLite for true zero-config (Rails-8 stance), Postgres the moment you need pub/sub-realtime, pgvector, or scale. Likely: SQLite local, Postgres prod, one API over both.
- **In-house workflow layer vs DBOS** — decide at the workflow slice; both stay on the one DB.
- **better-auth ↔ Tracks** — better-auth owns its schema; confirm the DB-adapter seam vs. Tracks migrations.
- **Tailwind in Loom** — required for shadcn; confirm SSR + AI-tree registry still validate cleanly.
- **Hook system shape** — sync actions/filters (WP) vs. async events/listeners (Laravel): ship both, clarify when each fires.
- **Managed Keel Cloud** — scope/timing of the commercial layer.
