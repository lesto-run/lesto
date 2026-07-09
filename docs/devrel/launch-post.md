# Launch post + Show HN kit (DRAFT — publish at L1 detonation)

> Status: DRAFT (L-80ff5e22). Lives here, NOT in `www/content/blog/`, so a routine www
> deploy can't leak it early. On launch day: set the real `date`, move §1 to
> `www/content/blog/introducing-lesto.md`, build + deploy www, then post §2 to HN.
>
> Claims-reviewed against `docs/brand/messaging.md` v1 (2026-07-05). Gated claims —
> ALL must be true before this posts:
> 1. RELEASE-GATED: the scaffold agent on-ramp (AGENTS.md + Claude Code skill) and any
>    fresh-scaffold `describe_app` demo ship with the NEXT create-lesto publish — cut
>    that release first (ATTACK-PLAN-2027 Phase L0).
> 2. COMMUNITY-GATED: "GitHub Discussions are open" (L-f99bdb0d) and "`good-first-issue`
>    is seeded" (L-d51a3369) are written as already true — make them true first.
> 3. The screencast embed (L-62b22a91) is recorded and placed.
> 4. ✅ CLEARED 2026-07-08 (L-691e4e81): the battery set is PUBLISHED — all 13
>    (mail, cache, workflows, webhooks, identity, forms, flags, admin, realtime,
>    pubsub, mailing-lists, i18n, feeds) are on npm at 0.1.3 as part of a coordinated
>    0.1.3 workspace release, verified installable via a real `npm install`. The
>    "publish the batteries" narrative below is the live one — no scoping needed.

---

## §1 — The blog post (`www/content/blog/introducing-lesto.md`)

```markdown
---
title: "Introducing Lesto — batteries-included, agent-native"
description: The full-stack TypeScript framework you can drive from Claude, the CLI, or code — queue, auth, cache, workflows, email, and admin in the box, on one database.
date: "TODO-ON-PUBLISH"
author: The Lesto team
---
```

# Introducing Lesto — batteries-included, agent-native

Run this:

```sh
bunx create-lesto my-app && cd my-app && bun run dev
```

You get a running full-stack TypeScript app — SQLite-backed, server-rendered
React with one small hydrating island, seeded data, CSRF and rate-limiting on
by default. Nothing new there; every framework has a quickstart.

Here's the part that's different. Look at the dev output:

```
lesto dev: MCP control plane on http://127.0.0.1:52301/ (x-lesto-dev-token: …)
```

**Your dev server is an MCP server.** Point Claude Code (or any MCP client) at
that URL and call `describe_app`: one round-trip returns the app's routes, its
OpenAPI contract, its content collections, and its schema. The agent doesn't
grep your codebase to figure out what it's working on — it asks the running
app. Sessions are read-only by default; destructive tools sit behind an
audited operator mode. Every scaffold also ships `AGENTS.md` and a Claude Code
skill, so an agent's first session arrives already knowing the loop.

We think this is what frameworks look like from here on: not "AI-assisted
autocomplete over your files," but a runtime an agent can *interrogate and
operate*, with governance built in. We've been building Lesto agent-native
from the start, and it's why we're comfortable making the claim in the
tagline: **batteries-included, agent-native.**

## The batteries half

Lesto gives TypeScript the in-house "hard parts" Rails and Laravel ship in the
box — and puts them all on **one substrate: the SQL database.** SQLite for
zero-config local, Postgres at scale, the same APIs over both:

- **`@lesto/db`** — typed schema, migrations, relational queries with joins.
- **`@lesto/queue`** — durable jobs on the database (`SKIP LOCKED` on
  Postgres), plus scheduled/repeatable jobs. No Redis.
- **`@lesto/authz`** — roles, permissions, principals, guards.
- **`@lesto/storage`** — object storage, local FS → S3-compatible.
- **`@lesto/seo`, `@lesto/openapi`** — typed meta/sitemaps and a generated API contract.
- **`@lesto/workflows`** — multi-step work with resumable step memoization.
- **`@lesto/cache`, `@lesto/pubsub`, `@lesto/realtime`** — DB-backed caching
  and topic invalidation driving live `useQuery` over SSE: a write publishes a
  key, subscribers refetch through the authorized endpoint. No polling, and no
  row data on the wire.
- **`@lesto/identity`** — in-house auth (register / verify / login / reset,
  sessions).
- **`@lesto/mail`, `@lesto/mailing-lists`, `@lesto/webhooks`, forms, flags,
  i18n, feeds, an admin surface** — in-house, on the same database.
- **Observability that's actually a differentiator:** one trace from the
  browser, through the API, to the SQL — with agent operations (`ai.*` spans)
  on the same trace. No OpenTelemetry setup required; OTLP export when you
  want it.
- **Frontend:** server-rendered React with islands (Preact-aliased to ~10 KB
  gzip client), file-based routing, Tailwind v4 + shadcn first-class
  (`npx shadcn add button`), Vite dev with Fast Refresh.
- **Deploy:** `lesto deploy --cloudflare` — prerendered assets + a Worker in
  one atomic, versioned step.

And the newest battery, shipped as v1 and still hardening: **local-first
sync** — Postgres logical replication streaming into a durable local store
(OPFS SQLite) with an offline write outbox and cross-tab coordination, behind
one `live()` seam. We're saying "v1, in active hardening" on purpose; the
honest table below has the details.

## The honest table

We'd rather you find this here than in the comments:

| It | Status |
|---|---|
| db, queue, authz (RBAC), storage, seo, openapi, the agent/MCP plane, tracing | On npm today, 100% test coverage held per package |
| cache, workflows, auth (identity), email, mailing-lists, webhooks, forms, flags, admin, i18n, feeds, pubsub, realtime | **On npm today @ 0.1.3**, 100% test coverage held per package (published 2026-07-08 in the coordinated 0.1.3 workspace release) |
| Local-first sync (`live()`) | **v1, in hardening** — replication + durable store + offline outbox are real and CI-gated end-to-end; per-row sync authorization and a hardening list stand between this and an unqualified "offline" claim |
| Workflows | Resumable step memoization — **not** crash-safe durable execution yet |
| Realtime / pub-sub | On npm @ 0.1.3, but **v0** — the cross-process topic bus + SSE fan-out are still evolving alongside live `useQuery` |
| Agent control plane | Content, UI generation, requests, inspection — **schema migrations are not an MCP tool yet** (CLI only) |
| Content components, search/embeddings | Preview-labeled |
| Plugins/themes/extensibility | Designed, deferred post-1.0 |
| Benchmarks | We publish none until our harness produces numbers we'd defend — the harness is public in the repo |

Lesto is 0.x. APIs will move. 1.0 is criteria-boxed (stability contract,
external security audit, upgrade guides), not date-boxed.

## Try it

- `bunx create-lesto my-app` — a running full-stack app, MIT — with the full
  battery set installable from npm (published 2026-07-08 in the 0.1.3 release).
- No local setup? [Open in Codespaces](https://codespaces.new/lesto-run/lesto).
- Docs: [docs.lesto.run](https://docs.lesto.run) — and they're agent-readable:
  [`/llms.txt`](https://docs.lesto.run/llms.txt), every page has a Markdown
  twin at its path + `.md`. Tell your agent to read them.
- Source: [github.com/lesto-run/lesto](https://github.com/lesto-run/lesto) —
  GitHub Discussions are open, and `good-first-issue` is seeded.

*(embed: the 90-second wedge screencast — L-62b22a91)*

---

## §2 — Show HN kit

**Title (≤80 chars, no hype words):**

> Show HN: Lesto – batteries-included TypeScript framework you can drive from Claude

Fallback if too long / flagged: `Show HN: Lesto – a full-stack TS framework whose dev server is an MCP server`

**First comment (post immediately after submitting):**

Hi HN — I built Lesto because I wanted Rails/Laravel's "hard parts in the box"
in strict TypeScript, without assembling a vendor zoo: queue, cache, workflows,
auth, email, webhooks, content, admin — all on one SQL database (SQLite local,
Postgres at scale), deployable to Cloudflare in one command.

The part I most want feedback on is the agent surface. `lesto dev` boots a
loopback MCP server for the app itself — token-gated, read-only by default,
with an audited operator mode. An agent calls `describe_app` and gets the
routes, OpenAPI contract, collections, and schema in one round-trip instead of
grepping. Every scaffold ships AGENTS.md + a Claude Code skill. There's also
one trace from the browser through the API to the SQL, with agent operations
as spans on the same trace.

Honest table (also in the post): local-first sync is v1-in-hardening, not
"offline-ready"; workflows are resumable step memoization, not crash-safe;
schema migrations aren't an MCP tool yet; search/embeddings are
preview-labeled; plugins are deferred; we publish no benchmark numbers we
haven't measured (the harness is in the repo).

It's 0.x and APIs will move. I'll be in the thread all day — architecture
questions especially welcome. The docs are agent-readable
(docs.lesto.run/llms.txt) if you want to point your own tooling at them.

**Predictable pushback + the honest answers (prep, don't paste):**

- *"Another framework?"* — Fair. The bet is a category bet: nobody ships a
  coherent batteries+agent-governance stack; point at the honest table and the
  one-DB coherence rather than arguing.
- *"MCP is a fad."* — We don't argue the protocol; the claim is the shape: a
  runtime that exposes governed operations beats file-editing for agents. MCP
  is today's wire for that.
- *"Show me benchmarks."* — "We publish none we haven't measured; harness is
  public; cold-start/throughput runs are on the roadmap" (L-97e1bca5).
- *"Is the dev MCP a security hole?"* — Loopback-only, per-session token,
  Origin/Host gate, read-only default, 403s on a bad token — and it's proven
  nightly in CI on the published package (agent-activation gate).
- *"Local-first: real or vapor?"* — v1 shipped + CI-gated capstone
  (`examples/live-capstone`); the gap to "offline-ready" is named per-row
  authz + a public hardening list. Demo the capstone, don't overclaim.
