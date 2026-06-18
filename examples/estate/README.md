# examples/estate — auth-aware static, one origin

A two-zone site, the shape of `jademillsestates.com`, on **one origin**:

- **`/` — marketing**, `render: "static"`. Prerendered to HTML, CDN-cacheable,
  but **auth-aware**: the header carries a `My Account` **island** that resolves
  the signed-in user on the client.
- **`/mls` — the app**, `render: "dynamic"`. The live, authed zone. It owns the
  session (`@volo/auth`): it mints the cookie on sign-in and answers
  `/mls/api/session` — the same-origin endpoint the marketing island calls.

One origin means one cookie: the session set by `/mls` is seen by the static
`/` pages, with no CORS and no token plumbing.

## Run it

**Local development** — live render, instant edits, real island hydration:

```bash
bun run examples/estate/dev.ts        # or, in a real project: volo dev
```

`dev.ts` bundles the island client to `out/client.js`, then serves _every_ zone
**live** through the app's own `handle` (no prerender) on one port. It also
watches `src/` and `client.tsx`: edits to pages **and** island code rebuild the
bundle automatically, and the browser reloads itself (served HTML carries a tiny
script that polls `/__volo/version`). Open
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
                                                        #   <script id="volo-islands"> manifest
curl -i http://127.0.0.1:3000/mls                       # the dynamic app (a sign-in form)
curl -i http://127.0.0.1:3000/mls/api/session           # 401 — nobody signed in
curl -i -X POST http://127.0.0.1:3000/mls/api/sign-in   # 403 — no Sec-Fetch-Site (CSRF: originCheck)
curl -i -X POST -H "Sec-Fetch-Site: same-origin" \
     --data "email=jade@demo.example.com&password=demo-password-jade" \
     http://127.0.0.1:3000/mls/api/sign-in              # 303 + Set-Cookie: __Host-volo_session=...
curl -s -b "__Host-volo_session=<token>" \
     http://127.0.0.1:3000/mls/api/session              # 200 { "user": { "id": "jade@…", ... } }
curl -s -b "__Host-volo_session=<token>" \
     http://127.0.0.1:3000/mls/saved                    # gated: the user's saved listings
```

The bare `POST` is refused with a 403 on purpose: the `originCheck` CSRF
middleware reads the browser's `Sec-Fetch-Site` and a hand-rolled `curl` sends
none, so it looks cross-site. A real browser form post carries `same-origin` and
sails through — no per-form token to mint or verify. The `Set-Cookie` it returns
survives the path-mount front door verbatim, which is what makes the same-origin
session work.

## Tracing — the two-env-var setup (estate is the OTLP reference)

Estate dogfoods Volo's OTLP tracing the way every Volo app wires it. Tracing is
**off by default** (no tracer, no spans, zero overhead) and turns on with **one
environment variable**:

```bash
# Point VOLO_OTLP_URL at any OTLP/HTTP collector's trace endpoint:
VOLO_OTLP_URL=http://localhost:4318/v1/traces  bun run examples/estate/serve.ts
```

Two more optional vars tune it:

| Variable            | Purpose                                                  | Default  |
| ------------------- | -------------------------------------------------------- | -------- |
| `VOLO_OTLP_URL`     | The collector's trace endpoint. **Absent → tracing off.**| _(unset)_ |
| `VOLO_OTLP_SERVICE` | The `service.name` resource attribute.                   | `volo`   |
| `VOLO_OTLP_HEADERS` | Extra headers, comma-separated `key=value` (an auth token, a tenant id), e.g. `authorization=Bearer t,x-tenant=acme`. | _(none)_ |

With `VOLO_OTLP_URL` set, every served request mints an `http.request` span, and
the per-domain seams wired in `src/app.ts` / `src/identity.ts` become **child
spans of the request span**: a `db.query` per executed query, an
`identity.<event>` per auth lifecycle event, a `mail.delivered` per rendered
email, and a `client.island_error` per browser hydration-failure beacon. An
inbound W3C `traceparent` header joins the request into the caller's trace (one
trace across services), and an outbound webhook carries `traceparent` onward.

Spans flush to the collector on a **5-second interval** and once more on
**graceful drain** (`SIGTERM`/`SIGINT`), so a rolling restart never drops the
final batch. The exporter buffer is bounded (drop-oldest, with a drop count), so
telemetry sheds load under backpressure instead of leaking memory.

The wiring is the canonical reference: `serve.ts` constructs the tracer with
`tracesFromEnv(process.env, { currentSpan: currentRequestSpan })` and passes
`{ tracer, parseTraceparent, onDrain }` to `serve` — exactly what `volo serve`
does, and exactly the contract the Cloudflare edge adapter mirrors with
`ctx.waitUntil(traces.flush())`.

## How the pieces compose

| Concern                                           | Package                                              |
| ------------------------------------------------- | ---------------------------------------------------- |
| Declare the two zones                             | `@volo/sites` `defineSites`                          |
| Prerender the static zone (fail on a broken page) | `@volo/sites` `buildStaticSites`                     |
| Path-mount both zones on one origin               | `@volo/runtime` `dispatchSites` + `nodeStaticReader` |
| The island + its hydration manifest               | `@volo/ui` `island` / `renderPage`                   |
| Mount the island in the browser                   | `@volo/ui/client` `hydrateIslands`                   |
| Sessions (mint / verify / revoke)                 | `@volo/auth`                                         |
| Assemble the app (one entrypoint)                 | `@volo/kernel` `createApp` ← `volo.app.ts`           |
| CSRF on state-changing requests (zero token)      | `@volo/kernel` `secureStack({ originCheck })`        |

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
bun run --filter @volo/cli volo deploy   # or: volo deploy --target marketing --dist dist
```

`volo deploy` builds the static sites (failing on any broken page), ships them
through an uploader, and prints the **routing manifest** — the single artifact
that tells a CDN/edge to send `/mls/*` to the node app and everything else to
the static bundle:

```
shipped marketing: 2 routes
mls: run `volo serve` (dynamic)
route /mls → dynamic
route / → static
```

## Deploy to Cloudflare (the edge)

The same app runs on a Cloudflare Worker (see
[ADR 0002](../../docs/adr/0002-edge-cloudflare.md)). `worker.ts` composes the app
through `@volo/cloudflare`'s `toFetchHandler` + `withAssets`; `src/edge.ts` is the
edge twin that swaps the in-memory session store for **stateless signed
sessions** (`@volo/auth`'s `SignedSessions`) — a Worker isolate is ephemeral and
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
bun run build.ts                     # prerender marketing + bundle client.js → out/marketing
wrangler login                       # once, if not already authenticated
wrangler secret put SESSION_SECRET   # the signing secret; the trust root, never committed
wrangler deploy                      # ship the Worker (worker.ts) + the static assets
```

The deploy **fails closed**: `SESSION_SECRET` is mandatory. With it unset, the
Worker throws on the first request rather than signing sessions with a committed
key — the committed fallback secret and the passwordless `?as=` demo sign-in are
reachable **only** under an explicit `VOLO_DEMO=1` binding (which `serve.ts` /
`dev.ts` set for you locally, and a real deploy never sets). This is the
framework's pattern for every secret-bearing Worker: production is the default,
demo is the loud opt-in.

> **`VOLO_DEMO` is a Worker binding, not a build variable.** `VOLO_DEMO=1 bun run
> build` only affects the *build shell* (the static prerender) — it does **not**
> reach the deployed runtime, so the Worker still fail-closes. To run the deployed
> Worker in demo mode you must set it as a Worker var (`"vars": { "VOLO_DEMO": "1" }`
> in `wrangler.jsonc`, or `wrangler deploy --var VOLO_DEMO:1`). The supported
> production path is `wrangler secret put SESSION_SECRET` above.

`build.ts` runs the same assembly `serve.ts` does (`buildProductionSite`),
leaving `out/marketing/` with the prerendered pages and `client.js` beside them
— which is what `wrangler.jsonc` binds as the `ASSETS` static site. (estate runs
in-process, so it has no `volo.app.ts` and there is no global `volo` command to
invoke — `bun run build.ts` is its build entry.)

`wrangler.jsonc` is already written (by `@volo/cloudflare`'s `wranglerConfig`):
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
