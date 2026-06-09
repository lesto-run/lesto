# examples/estate — auth-aware static, one origin

A two-zone site, the shape of `jademillsestates.com`, on **one origin**:

- **`/` — marketing**, `render: "static"`. Prerendered to HTML, CDN-cacheable,
  but **auth-aware**: the header carries a `My Account` **island** that resolves
  the signed-in user on the client.
- **`/mls` — the app**, `render: "dynamic"`. The live, authed zone. It owns the
  session (`@keel/auth`): it mints the cookie on sign-in and answers
  `/mls/api/session` — the same-origin endpoint the marketing island calls.

One origin means one cookie: the session set by `/mls` is seen by the static
`/` pages, with no CORS and no token plumbing.

## Run it

**Local development** — live render, instant edits, real island hydration:

```bash
bun run examples/estate/dev.ts        # or, in a real project: keel dev
```

`dev.ts` bundles the island client to `out/client.js`, then serves _every_ zone
**live** through the app's own `handle` (no prerender) on one port. It also
watches `src/` and `client.tsx`: edits to pages **and** island code rebuild the
bundle automatically, and the browser reloads itself (served HTML carries a tiny
script that polls `/__keel/version`). Open
`http://127.0.0.1:3000` in a browser: the header shows "Sign in"; go to `/mls`
and sign in; back on `/`, the `My Account` island has hydrated and greets you —
one origin, one cookie.

**Production shape** — prerender then path-mount:

```bash
bun run examples/estate/serve.ts
```

That prerenders the marketing site to `out/`, then serves both zones behind one
node:http server. Try the loop:

```bash
curl -i http://127.0.0.1:3000/                          # static marketing HTML; note the
                                                        #   <script id="keel-islands"> manifest
curl -i http://127.0.0.1:3000/mls                       # the dynamic app (a sign-in form)
curl -i http://127.0.0.1:3000/mls/api/session           # 401 — nobody signed in
curl -i -X POST http://127.0.0.1:3000/mls/api/sign-in   # 303 + Set-Cookie: keel_session=...
curl -s -b "keel_session=<token>" \
     http://127.0.0.1:3000/mls/api/session              # 200 { "user": { "id": "jade", ... } }
curl -s -b "keel_session=<token>" \
     http://127.0.0.1:3000/mls/saved                    # gated: the user's saved listings
```

The `Set-Cookie` from `/mls/api/sign-in` survives the path-mount front door
verbatim — that is what makes the same-origin session work.

## How the pieces compose

| Concern                                           | Package                                              |
| ------------------------------------------------- | ---------------------------------------------------- |
| Declare the two zones                             | `@keel/sites` `defineSites`                          |
| Prerender the static zone (fail on a broken page) | `@keel/sites` `buildStaticSites`                     |
| Path-mount both zones on one origin               | `@keel/runtime` `dispatchSites` + `nodeStaticReader` |
| The island + its hydration manifest               | `@keel/ui` `island` / `renderPage`                   |
| Mount the island in the browser                   | `@keel/ui/client` `hydrateIslands`                   |
| Sessions (mint / verify / revoke)                 | `@keel/auth`                                         |

## The auth island, tested

`test/auth-island.test.tsx` proves the loop in jsdom: it renders the page the way
the build does (the island ships as its signed-out **fallback**), hydrates it,
and watches it resolve the (stubbed) session and rewrite itself to greet the
user. Run it:

```bash
./node_modules/.bin/vitest run examples/estate/test/auth-island.test.tsx
```

## Deploy

```bash
bun run --filter @keel/cli keel deploy   # or: keel deploy --target marketing --dist dist
```

`keel deploy` builds the static sites (failing on any broken page), ships them
through an uploader, and prints the **routing manifest** — the single artifact
that tells a CDN/edge to send `/mls/*` to the node app and everything else to
the static bundle:

```
shipped marketing: 2 routes
mls: run `keel serve` (dynamic)
route /mls → dynamic
route / → static
```

## Deploy to Cloudflare (the edge)

The same app runs on a Cloudflare Worker (see
[ADR 0002](../../docs/adr/0002-edge-cloudflare.md)). `worker.ts` composes the app
through `@keel/cloudflare`'s `toFetchHandler` + `withAssets`; `src/edge.ts` is the
edge twin that swaps the in-memory session store for **stateless signed
sessions** (`@keel/auth`'s `SignedSessions`) — a Worker isolate is ephemeral and
per-PoP, so a token must carry its own proof, not point at a store the next
isolate doesn't have.

The whole loop is proven in `test/edge-auth.e2e.test.ts`, driving the actual
Worker `fetch` handler over Node's standard `Request`/`Response`: signed-out →
401, sign-in → signed `__Host-` cookie, cookie → gated resource, forged cookie →
401, and **a cookie from one handler verifies in a second with the same secret
and no shared store** (the property that makes auth work across isolates).

The runbook — three commands from `examples/estate/`, with
[wrangler](https://developers.cloudflare.com/workers/wrangler/) installed and
`wrangler login` done:

```bash
keel build --target marketing       # prerender the static zone → out/marketing
wrangler secret put SESSION_SECRET   # the signing secret; the trust root, never committed
wrangler deploy                      # ship the Worker + the static assets
```

`wrangler.jsonc` is already written (by `@keel/cloudflare`'s `wranglerConfig`):
`main` → `worker.ts`, `nodejs_compat` on (for the `node:crypto` HMAC), and
`out/marketing` bound as the `ASSETS` static site. After deploy the marketing
site is a cached CDN asset and `/mls` runs the Worker — one origin, one signed
session across both.

> This repo's build environment has no `wrangler` or Cloudflare credentials, so
> those three commands are the operator's step. Everything they invoke is built
> and tested here; the deploy is the only unautomated hop.

## Notes

- The browser bundle is produced by `bun build client.tsx` (see `dev.ts`); any
  bundler works. Without it, pages degrade gracefully to the island's signed-out
  fallback (progressive enhancement).
- Promoting the client `resolveSession` helper into a shared framework package
  is a natural next step.
