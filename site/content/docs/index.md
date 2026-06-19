---
title: Introduction
description: Lesto is a batteries-included, full-stack JavaScript framework that runs the same app on a Node server and the Cloudflare edge.
section: Getting started
order: 0
---

# Lesto

Lesto is a batteries-included, full-stack TypeScript framework. One app, written
once, runs on a long-lived Node server **and** on the Cloudflare edge — with the
same routing, the same data layer, and the same security hardening on both tiers.

It ships the parts most apps re-assemble by hand:

- a **typed data layer** with migrations and a cross-dialect SQLite/Postgres query builder
- a **background job queue** with exactly-once delivery, retries, and a dashboard
- **authentication** — register, verify, login, password reset, TOTP — out of the box
- **server-rendered pages** with optional interactive islands and client-side soft navigation
- a **single deploy** to a Node host or a Cloudflare Worker, from the same source

This very site is a Lesto app. Every page you are reading is a Markdown file,
rendered to HTML at build time by Lesto's content packages and served as static
files from Cloudflare's edge. The source lives in [`site/`](https://github.com/lesto-run/lesto/tree/main/site).

## The shape of an app

A Lesto app is a `lesto()` builder — routes, pages, and middleware — booted by
the kernel over a database handle:

```ts
import { lesto } from "@lesto/web";

export const app = lesto()
  .page("/", { component: Home, metadata: () => ({ title: "Home" }) })
  .get("/api/health", (c) => c.json({ ok: true }));
```

That same `app` is served by a Node process in development and wrapped into a
Cloudflare Worker for the edge — no rewrite, no second framework.

## Where to go next

- **[Quickstart](/quickstart)** — scaffold an app and deploy it in a few minutes.
- **[Data](/batteries/data)**, **[Queue](/batteries/queue)**, **[Auth](/batteries/auth)** — the batteries, one page each.
- **[Deploy to Cloudflare](/deploy/cloudflare)** — the production runbook.
