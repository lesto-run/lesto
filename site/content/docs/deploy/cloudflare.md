---
title: Cloudflare
description: Deploy a Lesto app to Cloudflare Workers — static assets, the Worker entry, secrets, and the edge database.
section: Deploy
order: 0
---

# Deploy to Cloudflare

A Lesto app deploys to Cloudflare as a Worker that serves prerendered static
files first and runs the live app for everything else — the same app you run
under Node, wrapped for the edge.

## The pieces

- **`worker.ts`** — the Worker entry. It wraps your app with `withAssets`, which
  serves a matching prerendered file from the `ASSETS` binding (cached at the
  edge, no isolate) and falls through to the app on a miss.
- **`wrangler.jsonc`** — the Cloudflare config: the `assets` binding pointing at
  your build output, `nodejs_compat`, and any database bindings.

```ts
// worker.ts — the shape of an edge front door
import { toFetchHandler, withAssets } from "@lesto/cloudflare";

export default {
  fetch(request, env, ctx) {
    return withAssets(env.ASSETS, appHandler)(request, ctx);
  },
};
```

## Build and ship

```bash
npm run build        # prerender static zones (and bundle islands, if any)
npx wrangler login   # once
npx wrangler deploy  # upload the Worker + static assets in one step
```

## Secrets

Anything sensitive — a session signing secret, API keys — is a Wrangler secret,
never committed. Auth fails closed if its secret is unset, so set it before the
first authed deploy:

```bash
npx wrangler secret put SESSION_SECRET
```

## The edge database

A Worker has no filesystem SQLite, so a data-driven app binds a database at the
edge:

- **D1** — Cloudflare's SQLite. `wrangler d1 create <name>`, then add the binding
  to `wrangler.jsonc`.
- **Hyperdrive** — pooled Postgres, for the "SQLite locally → Postgres at scale"
  path. Add a `hyperdrive` binding; it takes precedence over D1 when present.

`@lesto/db`'s query builder runs unchanged against either.

## This site

The page you are reading is deployed exactly this way. It is fully prerendered,
so its `worker.ts` is a thin fallback that only renders a 404, and its
`wrangler.jsonc` binds `out/docs/` as static assets — no secret, no database.
The source is [`site/`](https://github.com/lesto-run/lesto/tree/main/site).

```bash
cd site
bun run build.ts     # prerender every Markdown page to out/docs/
npx wrangler deploy  # serve them from Cloudflare's edge
```

For a complete authed, database-backed deploy, see
[`examples/estate`](https://github.com/lesto-run/lesto/tree/main/examples/estate).
