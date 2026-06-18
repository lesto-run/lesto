# ADR 0002 — Volo on Cloudflare Workers (edge SSR-auth)

- **Status:** Accepted (MVP implemented)
- **Date:** 2026-06-09
- **Context:** executes phase 3 of [ADR 0001](./0001-sites-and-targets.md) — edge SSR-auth — with Cloudflare Workers as the first real edge target.

## Decision

Run the **whole Volo dispatcher inside a Cloudflare Worker.** Volo's request
handling is already a pure function — `app.handle` / `dispatchSites` is
`(method, path, options) => Promise<VoloResponse>` with no `node:http`, no
sockets. A Worker is just `fetch(Request) => Response`. So putting Volo on the
edge is *adapting the shapes*, not porting an engine:

```ts
// worker.ts
const dispatch = dispatchSites({ sites, handle: app.handle, readStatic });
const app = toFetchHandler(dispatch);            // @volo/cloudflare
export default { fetch: (req, env) => withAssets(env.ASSETS, app)(req) };
```

"Edge SSR-auth" falls out for free: the Worker reads the session cookie and SSRs
the auth-aware page at the edge, in the same code path the node server runs.

## The five decisions that shaped the MVP

1. **One Worker + Static Assets, split by `withAssets`.** The prerendered static
   zone is served by Cloudflare Static Assets (cached at the PoP, no isolate);
   the dynamic zone runs the Worker. `withAssets(env.ASSETS, app)` tries assets
   first, falls through to the app on a 404 — the same static-then-dynamic front
   door the node runtime makes, in Cloudflare's primitives.

2. **Stateless signed sessions — the edge auth model.** Worker isolates are
   ephemeral and per-PoP, so `MemorySessionStore` is empty on the next request
   and a DB round-trip defeats the edge. `@volo/auth`'s **`SignedSessions`**
   carries the claim (`userId`, `expiresAt`) plus an HMAC-SHA256 signature under
   a server secret; any isolate holding the secret verifies a session it never
   issued, with no store. Trade-off: no pre-expiry revocation — keep TTLs short,
   and pair with store-backed `Sessions` when instant revocation matters.

3. **`nodejs_compat` for `node:crypto`.** Volo's crypto (the signed-session
   HMAC, password hashing) is synchronous `node:crypto`. Workers provide it under
   the `nodejs_compat` flag, so the sync house style holds at the edge —
   `wranglerConfig` always emits that flag.

4. **`compatibility_date` is an input, never derived.** A generated config must
   be reproducible, so `wranglerConfig` takes the date as an option (never
   `new Date()`), consistent with Volo's no-ambient-time rule.

5. **D1 (async-only) is out of MVP scope.** Volo's `SqlDatabase` is synchronous
   while Cloudflare D1 is async-only — bridging them is real work and the MVP
   target (the estate site) needs no database at the edge (content is
   prerendered; sessions are stateless). **Known follow-up:** an async
   `SqlDatabase` variant (or a buffered adapter) for DB-backed apps on D1.

## What this is and isn't

- **Is:** a deployable Worker that serves a two-zone site (static `/` + dynamic
  authed `/mls`) on one origin, with edge-verified signed sessions and a
  generated wrangler config. Verified end-to-end against Node's global
  `Request`/`Response` (a Worker *is* `fetch`), including the cross-isolate
  property (a token issued by one handler verifies in another with the same
  secret, no shared store).
- **Isn't:** a live deploy from this repo (no `wrangler`/credentials in the build
  environment — the final `wrangler deploy` is the operator's step, documented in
  the estate runbook), and not DB-at-the-edge (decision 5).

## Consequences

- Volo runs unmodified on Cloudflare — same dispatcher, same controllers, same
  islands; only the transport adapter and the session model change, both
  additive (`@volo/cloudflare`, `SignedSessions`), nothing in the core touched.
- The static marketing zone is a cached CDN asset; the app is one Worker; the
  session is one signed cookie across both — the auth-aware-static goal, on the
  edge.
- The secret (`SESSION_SECRET`) is the whole trust root for stateless sessions;
  it is a wrangler secret, never committed, and rotating it invalidates all live
  sessions (acceptable given short TTLs).
