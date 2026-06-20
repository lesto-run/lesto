---
title: Concepts
description: How a Lesto app is shaped — the app builder, the kernel, pages and islands, sites, and one app across Node and the edge.
section: Getting started
order: 2
---

# Concepts

A Lesto app is a handful of small pieces that compose. Once you know them, the
whole framework reads the same way.

## The app builder

`lesto()` builds the app: routes, pages, middleware, and data sources, chained
into one value. It is just a description — nothing runs until the kernel boots it.

```ts
import { lesto } from "@lesto/web";

export const app = lesto()
  .layout(Layout)
  .page("/", { component: Home })
  .get("/api/health", (c) => c.json({ ok: true }));
```

## The kernel

`createApp(config)` boots the app over a database handle: it applies migrations,
wires the security baseline (rate-limit on by default; CSRF/CORS opt-in), threads
the `db` through every route, and returns an `App` whose `handle(method, path)`
dispatches a request. The same `handle` serves a live request, a test, and the
static prerender.

## Pages and islands

A **page** is a component with an optional server `load`; it renders to HTML on
the server. An **island** is an interactive component that hydrates on the
client — opt-in, so a page ships zero JavaScript until it has one. This very site
is all static pages plus a single search island.

## Sites

`lesto.sites.ts` declares your **zones**: each is `static` (prerendered to files,
served from a CDN) or `dynamic` (served live). One origin can mix both — a static
marketing site at `/` and a dynamic app at `/app`.

## One app, two runtimes

The same app runs on a long-lived **Node** server and on the **Cloudflare** edge.
The Node front door and the Worker apply the same hardening (per-request context,
security headers, error boundary); only the transport differs. You write the app
once. See **[Deploy](/deploy/cloudflare)**.
