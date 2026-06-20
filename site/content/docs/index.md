---
title: Introduction
description: Lesto is a batteries-included, full-stack JavaScript framework that runs the same app on a Node server and the Cloudflare edge.
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

- **[Data](/batteries/data)** — a typed query builder over one `SqlDatabase`
  handle. The same schema value backs your queries and your DDL, and the same
  builder runs against SQLite locally and Postgres in production.
- **[Migrations](/batteries/migrations)** — versioned `up`/`down` migrations,
  applied on boot, rendered as DDL for whichever dialect you run.
- **[Queue](/batteries/queue)** — a database-backed job queue with exactly-once
  delivery, retries, batches with dependencies, and an operator dashboard. No
  Redis, no broker.
- **[Auth](/batteries/auth)** — register, verify, login, password reset, and
  two-factor TOTP, with sessions that work on both Node and the edge.
- **[Authorization](/batteries/authz)** — role-based access control with grants,
  wildcards, and inheritance; guard one route or a whole subtree.
- **[Admin](/batteries/admin)** — a typed CRUD backbone over your tables, with
  validation, a field allow-list, and a mutation hook for auditing.
- **[Email](/batteries/email)** — transport-agnostic transactional mail, plus
  double-opt-in mailing lists and broadcasts.
- **[Feature flags](/batteries/flags)** — typed flags with safe defaults; gate a
  route or a subtree behind one.
- **[Observability](/batteries/observability)** — built-in distributed tracing,
  a span per request, exported over OTLP from two environment variables.
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

Every page you are reading is a Markdown file. Lesto's content packages
(`@lesto/content-core`, `@lesto/content-markdown`, `@lesto/content-store`) render
it to HTML at build time, and the result is prerendered to static files served
from Cloudflare's edge — so the docs ship as a thin Worker that only falls back
to a 404. The one interactive piece is a single search island, built on
`@lesto/content-search`. The source lives in
[`site/`](https://github.com/lesto-run/lesto/tree/main/site).

## Where to go next

- **[Quickstart](/quickstart)** — scaffold an app, run it locally, and deploy in
  a few minutes.
- **[Concepts](/concepts)** — the app builder, the kernel, pages and islands,
  zones, and one app across Node and the edge.
- **[Deploy to Cloudflare](/deploy/cloudflare)** — the production runbook:
  secrets, static assets, and the edge database.
