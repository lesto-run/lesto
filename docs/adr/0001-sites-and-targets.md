# ADR 0001 — Sites & Targets: one substrate, many deployments

- **Status:** Proposed
- **Date:** 2026-06-09
- **Deciders:** tech lead (pending owner sign-off)

## Context

A real product is rarely one deployment. You ship a **marketing site**, a **docs
site**, a **blog**, and the **app** — and today that means four repos or four
tools (a static-site generator for docs, a headless CMS for marketing, a
framework for the app, a separate blog), each with its own deploy, its own
design system drifting out of sync, and no shared auth or content.

Two questions forced this ADR:

1. **"Why markdown files at all — why not store content in the DB and edit it in
   Studio?"** We already support both: git-markdown flows in through
   `volo content:build`, and Studio/agents write straight to the DB through the
   content-store CRUD + MCP tools. The DB is the substrate; markdown is one
   *source*. We keep both deliberately (see Decision → Content sources).
2. **"Could one project emit a docs/blog static site *alongside* the fullstack
   app?"** Yes — and that is the prize this ADR is really about.

**Owner constraint & concrete target.** The goal is a site shaped like
**jademillsestates.com**: a **static luxury-marketing site at `/`** (listings
showcase, neighborhood guides, blog/press, contact + newsletter forms, and a
**"My Account"** link that reflects signed-in state) on the **same domain** as a
**dynamic, authed MLS app at `/mls`** (property search, list/map toggle,
draw-to-search, Login/Register, and per-user **Saved** listings/searches). Two
zones, one domain, one session. So **auth-aware static is a day-one
requirement** — the marketing shell must show signed-in state and post forms —
and the split is **path-based under one origin**, not separate subdomains. That
shapes both the auth model (same-origin) and the deploy model (a path
front-door); see Decision.

### What already exists (the pieces are mostly here)

- `createApp(config)` → `App` whose **`app.handle(method, path, opts)` is a pure
  function from request to `VoloResponse`** — already returns SSR'd HTML (the
  `examples/blog` controller renders via `renderTree` and `curl` gets HTML).
- `@volo/ui` — `renderTree(tree, registry)` renders a validated UI tree to HTML
  against a component **`Registry`**. This is the theming surface.
- `@volo/router` — declares routes, resolves `method + path → controller#action`.
- `@volo/content-core` + `@volo/content-store` — the content engine and its
  projection onto the SQL substrate; `getCollection`/`getEntry`/`query` at runtime.
- `@volo/auth` — sessions and tokens; `@volo/cors` — credentialed origins.
- `@volo/runtime` — `serve(app, opts)` (the dynamic web tier) and `runWorker`.
- DEPLOY.md — the deployment model is already "one durable substrate (the DB),
  everything else stateless."

### What is missing

There is no notion of **more than one site** per project, no **static export**
(the app can only be *served*, not prerendered to files), and no **islands**
(client-hydrated regions inside an otherwise static page) — which auth-aware
static requires.

## Decision

Introduce **Sites & Targets**: a Volo project declares one or more **sites**,
each a named view over the shared substrate with its own routes, theme, content,
and **render mode**. A site renders either **dynamically** (the `volo serve`
process we have) or **statically** (a prerendered shell + hydrating islands).

The keystone is small and already true:

> **A static site is the dynamic app, prerendered.** Because `app.handle("GET",
> path)` is a pure request→response function that already returns HTML, static
> export is just *calling it offline for each page and writing the bytes to
> disk*. No second renderer, no divergent code path. A site can flip between
> `static` and `dynamic` with a config field, not a rewrite.

The only thing the static shell can't bake in is **per-user state** — so the
parts of a page that depend on who's looking are **islands** that hydrate on the
client. That is exactly what makes auth-aware static work.

### Site target shape

```ts
// volo.sites.ts
export default defineSites([
  {
    name: "app",          // the dynamic application (what we have today)
    render: "dynamic",
    basePath: "/",
    router: appRouter,
    theme: appTheme,      // a Loom Registry + layout
    deploy: { adapter: "node" },
  },
  {
    name: "marketing",    // static luxury-marketing site at the root
    render: "static",
    basePath: "/",
    content: ["listings", "neighborhoods", "posts"], // showcase, guides, blog
    theme: marketingTheme,
    auth: { app: "mls" }, // the "My Account" island resolves sessions against `mls`
    deploy: { adapter: "static" },
  },
  {
    name: "mls",          // the dynamic, authed MLS application
    render: "dynamic",
    basePath: "/mls",
    router: mlsRouter,    // search, list/map, draw-to-search, per-user Saved
    theme: appTheme,
    deploy: { adapter: "node" },
  },
])
```

The two zones share one origin (`/` and `/mls` on jademillsestates.com), so the
session is same-origin (see Auth-aware static). Single-app projects are the
degenerate case: one site, `render: "dynamic"`. **Nothing breaks** —
`defineSites` defaults to wrapping the existing `AppConfig` as one dynamic site.

### Render modes

| Mode | Shell renders | Per-user parts | Needs DB at runtime? | Deploy |
|---|---|---|---|---|
| `dynamic` | per request, via `serve` | inline (server has the session) | yes | node process (`volo serve`) |
| `static` | once at build, via offline `app.handle` | **islands**, hydrated on the client | **no** for the shell; islands call the app API | static files → CDN (+ the app API for authed data) |
| `edge` *(later)* | per request at the CDN edge | inline (edge verifies the session) | token verify only | static + edge function |

`static` is what solves the deployment-sprawl pain: **the shell is a cheap,
anonymous, cacheable CDN deploy with no server and no database**, and auth-aware
regions light up via islands.

### Auth-aware static (day one)

A prerendered file is identical for every visitor, so per-user auth **cannot**
live in the baked HTML. Auth-aware static is a **static shell with auth
islands**:

- The shell, layout, and **public** content are prerendered (CDN, anonymous,
  cacheable).
- Auth-dependent regions are **islands** — they ship a small client bundle and
  hydrate at load against the user's session.
- The **session is owned by the dynamic app** (`@volo/auth`). In the primary
  layout — **two zones on one origin** (`/` and `/mls` on jademillsestates.com) —
  the session cookie is **same-origin**: it is set by `/mls` and sent to the
  static `/` pages automatically. The "My Account" island reads it (or calls
  `/mls/api/session`) **same-origin — no CORS, no cross-domain cookie setup**.
  *(If you instead split sites across subdomains, fall back to a parent-domain
  cookie + credentialed CORS via `@volo/cors`. The same-origin path layout — what
  the target uses — avoids all of that.)*

**Security boundary (non-negotiable):** **gated content is never baked into the
CDN HTML** — it would be world-readable. The static shell ships only public
markup; an auth island **fetches gated content from the app's authed API** once
the session is confirmed. "Static + auth" = a public shell on the CDN + private
data from the app, stitched on the client.

What this needs in v1:

- **Islands in `@volo/ui`** — a node type that renders a server placeholder and
  records a client component + its props, plus a hydration manifest the exporter
  emits beside the HTML.
- **An auth island + session resolver** — a client that reads the shared
  `@volo/auth` session and exposes `user` / `signedIn` to islands, and a helper
  to fetch gated data from the app API.
- **Credentialed CORS** — the app marks each static site's origin as an allowed
  credentialed origin (`@volo/cors`, already in-tree) so islands can call it.

Deferred (not day one): an **edge adapter** that verifies the `@volo/auth` token
at the CDN edge and SSRs the auth-aware shell server-side — for no-JS clients and
faster authed first paint. The client-island model is the universal day-one path
that works on any plain CDN; the edge adapter is an optimization on top.

### Content sources — the markdown/DB question, settled

```
  git markdown ──(volo content:build)──┐
                                        ├──▶  content_entries (SQL substrate)  ──▶  sites read via runtime query
  Studio / agents ──(content-store)─────┘
```

- **Markdown-in-git** is the source for docs and engineering blogs: PR review,
  diffs, branches, offline, no DB to stand up for a contributor. (`--prune`
  keeps the substrate mirroring the files exactly.)
- **Studio/DB** is the source for marketing pages and any non-technical or
  dynamic content: WYSIWYG, no git.
- **Both project into one substrate.** Sites are *consumers* and never care which
  door content came through. Keeping both is the moat: nobody unifies
  docs-as-code **and** a WordPress-style editor on one queryable substrate.

### Theming

A theme is a Loom `Registry` (component set) plus a page layout. Sites share a
base design system (`@volo/ui-kit`) and override per site. The same registry that
renders dynamically renders statically — the export path is identical, and
island components come from the same registry.

### Serving model — the front door

Two zones share one origin, so something routes `/` → the static marketing shell
and `/mls/*` → the dynamic app. Two flavors:

- **Single node, path-mounted (v1, simplest).** One `volo serve` process mounts
  every site at its `basePath`: it serves the prerendered files for static zones
  and handles dynamic zones live. One process, one origin — same-origin auth and
  same-origin form posts work with zero extra setup. Ideal to start with and to
  self-host.
- **Split: CDN + node + edge router (scale).** Move static zones to a CDN, keep
  the app on node, put a path rule in front (`/mls/*` → app origin, else → CDN).
  Cheaper and faster for the heavy marketing traffic, same session because it is
  still one origin.

Static export produces the same artifact either way; only where the files sit
changes.

### Forms & actions on static pages

The marketing shell isn't read-only — it has contact and newsletter forms. Those
are **same-origin POSTs to the app API** (an action endpoint on the `mls` zone).
A static page can carry a form that posts to a dynamic handler because they share
the origin: a plain `<form>` needs no island, and an island only when the page
should update in place. Same mechanism as the auth island — static shell,
dynamic seam, one origin.

### Deploy adapters

- `static` — emit `out/<site>/<route>/index.html`, hashed assets, and island
  bundles; deploy to any static host (CDN, Pages, S3). No runtime.
- `node` — the existing `volo serve` process; serves dynamic zones live and can
  path-mount static zones (the v1 front door).
- (later) `edge` — verify session + SSR the shell at the edge.

### CLI surface

```
volo build  --target docs           # prerender one static site (shell + islands) to out/docs
volo build  --target all            # build every static site
volo serve  --target app            # run a dynamic site (today's `volo serve`)
volo deploy --target docs           # build + ship via the site's deploy adapter
```

`content:build` (source → substrate) and `build --target` (substrate → site
output) are distinct, composable steps.

## What we build vs. what exists

| Piece | Status |
|---|---|
| Pure `app.handle` render path | **exists** (`@volo/kernel`, `@volo/web`, `@volo/ui`) |
| Content substrate + sources | **exists** (`content-core`, `content-store`, CLI, MCP) |
| Dynamic serve | **exists** (`@volo/runtime serve`) |
| Sessions + credentialed CORS | **exists** (`@volo/auth`, `@volo/cors`) — wire per site |
| `defineSites` + site config | new (small) |
| **Static exporter** — enumerate a site's pages, call `app.handle` per page, write HTML + assets | new — `@volo/sites` |
| **Islands** — `@volo/ui` node type: server placeholder + client hydration manifest | new (in `@volo/ui`) |
| **Auth island + session resolver** — client reads the shared session, gates regions, fetches authed data from the app API | new (`@volo/sites` client) |
| Per-site routing (basePath, content→routes) | new (thin over `@volo/router`) |
| Deploy adapters (`static`, `node`) | new — `@volo/deploy` (thin) |
| `volo build/deploy --target` | new (CLI commands) |

The exporter and the island boundary in `@volo/ui` are the substantial new work;
everything else is thin or already built.

## Phasing

1. **`@volo/sites`: exporter + islands + auth island + path-mount serving.**
   `defineSites`; `volo build --target <s>` prerenders the shell via `app.handle`
   **and** emits island bundles + a manifest; a first-class **auth island**
   resolves the same-origin `@volo/auth` session and renders signed-in/out UI;
   `volo serve` path-mounts the site set (static files + dynamic zones) so `/` and
   `/mls` run on one origin. Ship a runnable **`examples/estate`** modeled on the
   target: a static marketing site at `/` with a "My Account" island and a
   contact form, plus a small dynamic authed `/mls` zone with a per-user Saved
   list. *(Islands, client auth, and the path front-door are all day-one for the
   auth-aware-static target.)*
2. **Deploy adapters + `volo deploy --target`.** Static adapter first (HTML +
   assets + island bundles + manifest), then node (wraps today's serve).
3. **Edge adapter + ISR.** Verify the session and SSR the shell at the edge
   (no-JS auth, faster authed paint); per-request incremental revalidation.

## Open questions / risks

- **Session verification trust.** v1 islands trust the app's session endpoint as
  authoritative (one credentialed fetch); the edge adapter (phase 3) verifies the
  `@volo/auth` token directly. Both keep the app as the auth authority.
- **Same-origin vs. subdomains.** The target is same-origin path zones, where
  the session just works (one origin, one cookie). Subdomain layouts need a
  parent-domain cookie + credentialed CORS and a documented DNS/cookie setup —
  supported, but not the default.
- **Island/asset pipeline.** Lean on Vite (`@volo/content-vite` already in-tree)
  to build + hash island bundles rather than hand-rolling.
- **Page enumeration.** Derive a site's pages from its content collections +
  declared routes (deterministic), not by crawling links.
- **Incremental builds.** Out of scope for v1; rebuild the whole site. The
  content cache already makes the pipeline half cheap.

## Non-goals (v1)

- Per-request ISR / on-demand revalidation (phase 3).
- Edge SSR-auth and no-JS auth (phase 3; client islands cover day-one auth).
- A visual site-*structure* builder (Studio edits content, not site layout, in v1).
- Multi-tenant site hosting. One project → its own sites.

## Consequences

- **One repo, one substrate, many deployments** — marketing/docs/blog as cheap
  static CDN deploys, the app as the one stateful node deploy, all sharing
  content, components, and a single session. This is the differentiator: "Rails
  + WordPress + Astro + Vercel multi-zone" in one framework.
- **Auth-aware static is first-class, with a clean cost/security split:** the
  public shell is a cacheable CDN file; private state and data come from the app
  via islands, so nothing private touches the CDN.
- **No divergent renderer**: static and dynamic are the same `app.handle` path;
  a site changes mode by config. Islands are the one new rendering concept, and
  they are shared by both modes.
- Adds two small packages (`@volo/sites`, `@volo/deploy`) and an island boundary
  in `@volo/ui`; the heavy lifting (render, content, substrate, sessions) exists.
