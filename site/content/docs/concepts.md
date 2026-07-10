---
title: Concepts
description: How a Lesto app is shaped — the app builder, the kernel, pages and islands, sites, and one app across Node and the edge.
section: Getting started
order: 3
---

# Concepts

A Lesto app is a handful of small pieces that compose. Each does one job, and the
seams between them are the same everywhere — so once you know the six ideas below,
the whole framework reads the same way.

## The app builder

`lesto()` is the one surface where you declare your app: API routes, pages,
middleware, layouts, and data sources, all on one chainable value. Every method
returns the app, so you build it up in a single expression. An API route is a
chain of handlers `(c, next) => response | void`; a page is the same kind of route
whose terminal handler renders a component. `.use` middleware wraps every route
declared after it, `.layout` nests around every page after it, and `.route` mounts
a sub-router with the parent's middleware and chrome composed back in.

```ts
import { lesto } from "@lesto/web";

export const app = lesto()
  .use(requestId())
  .layout(SiteChrome)
  .get("/api/listings/:id", (c) => c.json(getListing(+c.param("id"))))
  .page("/listings/:id", { load, component: ListingScene });
```

Pages can also be **file-routed**: drop a `page.tsx` under `app/routes/` and its
directory's URL becomes a route, with `layout.tsx` wrapping everything at or
below it. File routes compile onto the same router as hand-written ones — one
engine, two authoring styles.

Crucially, the app is *just a value*. The builder owns no transport and opens no
ports — nothing runs until something boots it. That is what makes the same app
testable, serveable, and prerenderable without change. See
[Routing & pages](/guides/routing) for the full route surface.

## The kernel

`createApp(config)` turns that description into a running app. It boots over a
database handle and owns the assembly order: it runs any pending migrations
*first*, so a handler's first query lands on a migrated schema; installs the
durable session and rate-limit tables; then wires the security baseline and
returns an `App`.

The security baseline is a pit-of-success default. Per-client rate limiting is
**on** unless you opt out — a flood-shedding net, since a forgetful app shipping
with no limit is a standing DoS vector. CSRF and CORS stay **off** by default: a
forced origin or token check would reject legitimate non-browser clients, and the
safe policy is deployment-specific. A browser app turns the recommended defense on
with one field.

```ts
import { createApp } from "@lesto/kernel";

const server = await createApp({
  db,
  app,
  migrations,
  secure: { browser: true }, // rate-limit baseline stays on; adds origin check
});

await server.handle("GET", "/listings/3");
```

The kernel threads the `db` through to your routes (handlers close over a typed
`Db`, never a global) and returns `App.handle(method, path)`. That one method
serves a live request, a test, and the static prerender — same code, three callers.

## Pages and islands

A **page** renders to HTML on the server. An **island** is an opt-in interactive
component that hydrates on the client — so a page ships zero JavaScript until it
grows one. How an island gets its data is the canonical rule (ADR 0012):

- On a **dynamic** page with `ssr: true`, the island's bound sources resolve at
  render time and inline straight into its props. The real component renders with
  real data, no client fetch, no fallback flash — **0 round-trips**.
- With `ssr: false`, the server renders the island's `fallback` and the client
  mounts the component **fresh** on load, fetching its own data.
- A **static** page resolves no per-request data at render — baking one visitor's
  data into cached HTML would serve it to everyone — so an `ssr: true` island that
  needs per-request data is refused at build time. Static islands fetch on the
  client instead.

This very site is all static pages plus a few small deferred (`ssr: false`)
islands. The docs search box is one: the server renders a plain trigger as the
fallback; the client mounts the real ⌘K palette, pulls the prerendered
`/search-index.json`, and searches it entirely in the browser — no server, no
model.

```ts
export default defineIsland({
  name: "Search",
  component: SearchBox,
  fallback: SearchInput,
  ssr: false,
});
```

## Sites & zones

A `lesto.sites.ts` declares your **zones** — named views over the one app, each
mounted at a path and rendered either `static` or `dynamic`. A static zone is
prerendered to files and served from a CDN with no runtime; its `pages` can be a
fixed list or a function that derives one from a content collection or a query at
build time. A dynamic zone is served live, per request, by the running app.

```ts
export default [
  { name: "marketing", basePath: "/", render: "static", pages: ["/", "/pricing"] },
  { name: "app", basePath: "/app", render: "dynamic" },
];
```

One origin can mix both: a static marketing site at `/` next to a live app at
`/app`. Because a static zone is just the same app rendered offline, a route that
answers with bytes (a generated image, a font) prerenders byte-identical.

## One app, two runtimes

The exact same app runs on a long-lived **Node** server and on the **Cloudflare**
edge. Both are thin adapters over `App.handle`: they build a per-request context,
apply the same hardening (rate limit, security headers, error boundary), and write
the response back. Only the transport differs — `node:http` versus a Worker's
`fetch`. You write the app once and choose where it runs at deploy time. See
[Deploy to Cloudflare](/deploy/cloudflare).

## Errors are coded

Every battery throws coded errors — `DbError`, `AuthError`, `WebError`, and the
rest — each a typed class carrying a stable code (`WEB_UNKNOWN_DATA_SOURCE`,
`WEB_DIALECT_MISMATCH`, and so on) plus structured context. The coded backbone is
what gives Node and the edge parity: the transport maps a coded error to the right
status the same way in both runtimes — a malformed request param becomes a 400, a
rate-limit refusal a 429 — so behavior is identical whether your app is answering
from a server or a Worker. You catch on the code, never on a brittle message match,
and your error handling ports unchanged between runtimes.

---

Next: wire up the [Data](/batteries/data) layer, follow [Routing &
pages](/guides/routing) end to end, or ship with [Deploy to
Cloudflare](/deploy/cloudflare).
