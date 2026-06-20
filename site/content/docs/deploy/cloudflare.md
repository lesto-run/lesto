---
title: Cloudflare
description: Deploy a Lesto app to Cloudflare Workers — static assets, the Worker entry, secrets, and the edge database.
section: Deploy
order: 0
---

# Deploy to Cloudflare

A Lesto app deploys to Cloudflare as a single Worker. It serves your prerendered
static files first and runs the live app for everything else — the same app you
run under [Node](/deploy/node), wrapped for the edge.

## The shape

Lesto's dispatcher is already a pure function — `(method, path, options) =>
Response`, with no `node:http`, no sockets, and no filesystem. A Worker is just
`fetch(Request) => Response`. So running on the edge is *adapting the shapes*, not
porting an engine:

- `toFetchHandler(dispatch)` turns your app's `handle` into a Worker `fetch`
  handler — same dispatch, same per-request context, same security headers, same
  error boundary the Node server applies.
- `withAssets(env.ASSETS, handler)` puts Cloudflare's Static Assets binding in
  front. A `GET`/`HEAD` is answered from the prerendered files first (cached at the
  PoP, no isolate spun up); only a 404 — "no such file" — falls through to the live
  app. A write (`POST`, `PUT`, `DELETE`) skips assets and goes straight to the app.

That static-then-dynamic split is the same front door the Node runtime makes,
expressed in Cloudflare's primitives.

## The pieces

Two files wire it up.

**`worker.ts`** — the Worker entry. Build the app once per isolate (it is pure CPU
that depends only on the secret, so don't rebuild it per request), then wrap it:

```ts
// worker.ts
import { toFetchHandler, withAssets } from "@lesto/cloudflare";
import type { AssetFetcher } from "@lesto/cloudflare";
import { buildApp } from "./src/app";

interface Env {
  readonly ASSETS: AssetFetcher;
  readonly SESSION_SECRET?: string;
}

let handler: ((request: Request, ctx?: ExecutionContext) => Promise<Response>) | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    handler ??= toFetchHandler(buildApp(env).handle);

    // `env.ASSETS` is per-request, so rewrap the cached handler each time.
    // `ctx` rides through so post-response work (an OTLP flush) can use waitUntil.
    return withAssets(env.ASSETS, handler)(request, ctx);
  },
};
```

**`wrangler.jsonc`** — the Cloudflare config: `main` (the entry above), the
`assets` binding pointing at your build output, the `nodejs_compat` flag, and any
data bindings.

```jsonc
{
  "name": "my-app",
  "main": "worker.ts",
  "compatibility_date": "2026-06-01",
  // node:crypto for the signed-session HMAC and password hashing.
  "compatibility_flags": ["nodejs_compat"],
  // The prerendered static site. Served first; a miss falls through to the Worker.
  "assets": {
    "directory": "./out",
    "binding": "ASSETS",
  },
}
```

`nodejs_compat` is load-bearing: Lesto's signed-session HMAC and password hashing
use synchronous `node:crypto`, which Workers provide only under that flag.
`@lesto/cloudflare` can generate this whole file for you — `wranglerConfig(plan,
options)` returns the config object and `serializeWranglerConfig` writes the exact
JSONC bytes — but a hand-written one works just as well.

## Build and ship

```bash
npm run build        # prerender static zones (and bundle islands, if any)
npx wrangler login   # once
npx wrangler deploy  # upload the Worker + static assets in one step
```

Or let the CLI gate the rollout for you:

```bash
lesto deploy --cloudflare --health-url https://<your-worker-url>/readyz
```

`lesto deploy --cloudflare` builds, pushes via `wrangler deploy`, then probes
`--health-url`. The result is **health-gated**: a failing probe triggers a
`wrangler rollback` automatically, so a broken deploy never stays live.

## Secrets

Anything sensitive — a session signing secret, API keys — is a Wrangler secret,
never committed:

```bash
npx wrangler secret put SESSION_SECRET
```

`SESSION_SECRET` is the trust root for every signed session, so a deployed app
**fails closed without it**: outside demo mode, an unset secret throws at boot and
the Worker refuses to serve a single request rather than sign sessions anyone could
forge. Set it before the first authed deploy.

## The edge database

A Worker has no filesystem, so the local SQLite path (`openSqlite`) is off the
table. A data-driven app binds a database at the edge instead — and `@lesto/db`'s
query builder runs unchanged against either of two:

- **D1** — Cloudflare's SQLite. Create it, paste the printed id into your
  `wrangler.jsonc`, and read it through `env.DB`:

  ```bash
  npx wrangler d1 create my-db   # prints the database_id
  ```

  ```jsonc
  "d1_databases": [
    { "binding": "DB", "database_name": "my-db", "database_id": "<id>" },
  ]
  ```

  In the Worker, `d1ToSqlDatabase(env.DB)` adapts the binding to the `SqlDatabase`
  surface `@lesto/db` consumes.

- **Hyperdrive** — pooled Postgres with edge-side connection caching, for the
  "SQLite locally → Postgres at scale" path. Add a `hyperdrive` binding, open its
  `connectionString` with a Workers-compatible postgres client, and pass it to
  `hyperdriveToSqlDatabase`. When a Hyperdrive binding is present it **takes
  precedence** over D1.

Either way the page runs the *identical* query path; only the driver and SQL
dialect differ.

## Sessions on the edge

Worker isolates are ephemeral and per-PoP, so an in-memory session store is empty
on the next request and a DB round-trip defeats the edge. The edge auth model is
**`SignedSessions`** (from [Auth](/batteries/auth)): the token carries its own
claim plus an HMAC-SHA256 signature under `SESSION_SECRET`, so any isolate holding
the secret can verify a session it never issued — no store, no round-trip. The
trade-off is no pre-expiry revocation, so keep TTLs short and reach for
store-backed sessions when instant revocation matters. This is why `nodejs_compat`
and `SESSION_SECRET` are both non-negotiable for an authed edge deploy.

## This site

The page you are reading is deployed exactly this way. It is fully prerendered, so
its `worker.ts` is a thin fallback that only renders a 404, and its `wrangler.jsonc`
binds the docs output as static assets — no secret, no database.

```bash
cd site
bun run build.ts     # prerender every Markdown page
npx wrangler deploy  # serve them from Cloudflare's edge
```

For a complete authed, database-backed deploy — signed sessions, a D1 store, the
secure stack mounted at the edge — see
[`examples/estate`](https://github.com/lesto-run/lesto/tree/main/examples/estate).
