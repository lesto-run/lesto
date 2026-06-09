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

| Concern | Package |
|---|---|
| Declare the two zones | `@keel/sites` `defineSites` |
| Prerender the static zone (fail on a broken page) | `@keel/sites` `buildStaticSites` |
| Path-mount both zones on one origin | `@keel/runtime` `dispatchSites` + `nodeStaticReader` |
| The island + its hydration manifest | `@keel/ui` `island` / `renderPage` |
| Mount the island in the browser | `@keel/ui/client` `hydrateIslands` |
| Sessions (mint / verify / revoke) | `@keel/auth` |

## The auth island, tested

`test/auth-island.test.tsx` proves the loop in jsdom: it renders the page the way
the build does (the island ships as its signed-out **fallback**), hydrates it,
and watches it resolve the (stubbed) session and rewrite itself to greet the
user. Run it:

```bash
./node_modules/.bin/vitest run examples/estate/test/auth-island.test.tsx
```

## What's a follow-up, not done here

The document references `/client.js` — the bundled browser entry
(`client.tsx`). Wire any bundler (e.g. Vite) to emit it; until then the pages
degrade gracefully to the island's signed-out fallback (progressive
enhancement). Promoting the client `resolveSession` helper into a shared
framework package is the other natural next step.
