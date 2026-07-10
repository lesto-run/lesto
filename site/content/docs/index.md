---
title: Introduction
description: Lesto is a batteries-included, full-stack TypeScript framework that runs the same app on a Node server and the Cloudflare edge.
section: Getting started
order: 0
---

# Lesto

Lesto is a batteries-included, full-stack TypeScript framework. You write one
app — routes, pages, data, jobs, auth — and the same source runs on a long-lived
Node server **and** on the Cloudflare edge, with the same routing, the same data
layer, and the same security hardening on both tiers. There is no second
framework for production, no rewrite to ship to the edge: a Node process serves
it in development, and a Cloudflare Worker wraps the identical app for deploy.

The core is deliberately disciplined, and the docs stay honest about it. The
data layer is a typed query builder — not an ORM: no `.save()`, no lazy-loading
proxy, no identity map. Distributed tracing is the named differentiator, and it
ships traces only — no metrics or logs pipeline yet. The AI battery is a preview.
Where a boundary is drawn, it is drawn on purpose, and the page for each battery
says exactly what is in and what is out.

## The batteries

Each battery is its own small package with its own page. You adopt the ones you
need; none reaches for a global.

### Data & storage

- **[Data](/batteries/data)** — a typed query builder over one `SqlDatabase`
  handle. The same schema value backs your queries and your DDL, and the same
  builder runs against SQLite locally and Postgres in production.
- **[Migrations](/batteries/migrations)** — versioned `up`/`down` migrations,
  applied on boot, rendered as DDL for whichever dialect you run.
- **[Cache](/batteries/cache)** — a TTL cache with single-flight stampede
  protection, over in-memory or SQL-backed stores.
- **[Object storage](/batteries/storage)** — one small file API with pluggable
  backends: in-memory and local disk for dev, S3/R2 in production.

### Jobs & messaging

- **[Queue](/batteries/queue)** — a database-backed job queue with exactly-once
  delivery, retries, batches with dependencies, and an operator dashboard. No
  Redis, no broker.
- **[Workflows](/batteries/workflows)** — resumable step memoization on the
  database: re-invoke a run and completed steps replay instead of re-running.
- **[Pub/sub](/batteries/pubsub)** — a dependency-free publish/subscribe hub
  with ordered delivery to sync and async listeners alike.
- **[Webhooks](/batteries/webhooks)** — HMAC-signed outbound webhooks as retried
  queue jobs, and inbound verification with replay and SSRF guarding.
- **[Email](/batteries/email)** — transport-agnostic transactional mail.
- **[Mailing lists](/batteries/mailing-lists)** — double-opt-in subscriber
  lists and resumable broadcasts over a durable delivery ledger.

### Identity & access

- **[Auth](/batteries/auth)** — register, verify, login, password reset, and
  two-factor TOTP, with sessions that work on both Node and the edge.
- **[Authorization](/batteries/authz)** — role-based access control with grants,
  wildcards, and inheritance; guard one route or a whole subtree.
- **[Admin](/batteries/admin)** — a typed CRUD backbone over your tables, with
  validation, a field allow-list, and a mutation hook for auditing.
- **[Security](/batteries/security)** — per-client rate limiting, CSRF/origin
  checks, and CORS, turned on with one `secure` field.

### Web & UI

- **[Sites](/batteries/sites)** — many sites over one app, each mounted at a
  path and rendered static or dynamic.
- **[Styling](/batteries/styling)** — first-class Tailwind v4: one CSS entry
  compiled to a served, hot-swapping stylesheet.
- **[UI components](/batteries/components)** — every scaffolded app is a generic
  shadcn/ui project; `npx shadcn add` works on day one.
- **[Forms](/batteries/forms)** — describe a form once as a spec, render it, and
  validate submissions against the same spec.
- **[Internationalization](/batteries/i18n)** — flat message catalogs,
  interpolation, and `Intl.PluralRules` pluralization.
- **[SEO](/batteries/seo)** — pure, escaping builders for meta tags,
  `sitemap.xml`, `robots.txt`, and JSON-LD.
- **[Feeds](/batteries/feeds)** — RSS 2.0 and Atom 1.0 feeds from
  dependency-free string builders.
- **[OpenAPI](/batteries/openapi)** — an OpenAPI 3.1 document generated straight
  from your route list.

### Agents & operations

- **[Agent control plane](/batteries/mcp)** — expose your running app's
  operations to an agent over MCP: read-only by default, destructive actions
  gated behind an explicit mode, every action audited.
- **[MCP governance](/batteries/mcp-governance)** — the model behind it: scopes
  versus roles, the audience guard, the mandatory audit trail.
- **[Observability](/batteries/observability)** — built-in distributed tracing,
  a span per request, exported over OTLP from two environment variables.
- **[Feature flags](/batteries/flags)** — typed flags with safe defaults; gate a
  route or a subtree behind one.
- **[Environment](/batteries/env)** — typed, validated environment variables
  that fail fast at boot, on Node, Bun, and the edge.
- **[AI](/batteries/ai)** — provider-agnostic text, streaming, an agent loop,
  retrieval, and evals over an injected transport. *Preview — expect it to move
  before 1.0.*

## The shape of an app

A Lesto app is a `lesto()` builder — routes, pages, and middleware chained into
one value. Nothing runs until the kernel boots it over a database handle:

```ts
import { lesto } from "@lesto/web";

export const app = lesto()
  .page("/", { component: Home, metadata: () => ({ title: "Home" }) })
  .get("/api/health", (c) => c.json({ ok: true }));
```

That same `app` is served by a Node process in development and wrapped into a
Cloudflare Worker for the edge — no rewrite, no second framework.

## This site is a Lesto app

Every page you are reading is a Markdown file. At build time `@lesto/content-core`
parses the collection and `@lesto/content-markdown` renders it to sanitized,
syntax-highlighted HTML; the result is prerendered to static files served from
Cloudflare's edge — so the docs ship as a thin Worker whose only job is the 404
fallback. The interactivity is a handful of small islands; the ⌘K search palette
is the framework's own `CommandPalette` from `@lesto/content-search`, searching
a prerendered index entirely in the browser. The source lives in
[`site/`](https://github.com/lesto-run/lesto/tree/main/site).

## Where to go next

- **[Why Lesto](/why-lesto)** — what it replaces, how it compares, and when not
  to use it.
- **[Quickstart](/quickstart)** — scaffold an app, run it locally, and deploy in
  a few minutes.
- **[Concepts](/concepts)** — the app builder, the kernel, pages and islands,
  zones, and one app across Node and the edge.
