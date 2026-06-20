# ADR 0023 — File-based routing convention

- **Status:** Accepted (implemented)
- **Date:** 2026-06-19
- **Deciders:** tech lead + owner
- **Supersedes nothing; builds on ADR 0004 (the code-first `lesto()` router + typed `:param`s), the `.page` authoring path (ADR 0011/0012), and the islands convention `app/islands/` (ADR 0011). Pairs with ADR 0024 (client soft navigation).**

## Context

Lesto's router is **code-first**: an app registers pages and routes by calling
`.page("/listings/:id", …)` / `.get(...)` on a `lesto()` builder, with the `:param`
names inferred into the handler's `c.param(...)` (ADR 0004). That is precise and
fully typed, but it is also the ONE place every peer meta-framework now offers a
lighter convention: **drop a file at a path, get a route**. Next's `app/`, Remix /
React-Router's routes, SvelteKit's `routes/`, Nuxt's `pages/`, Astro's `pages/` —
all let an author express "this URL renders this view, wrapped in these layouts"
as a directory tree, with dynamic segments as `[param]` directories. A framework
that pitches batteries-included DX while requiring every page to be hand-registered
is conspicuously behind on a table-stakes ergonomic.

The constraint is that we must NOT fork the router to get it. Lesto already has one
matcher, one typed-param story, one `.page` pipeline (load → metadata → static →
cache → render). A file convention that compiled to a *second* engine would double
the surface and split the typed-param inference. So the convention has to be a thin
front-end that **compiles to the existing `.page` registrations** — co-existing on
the same `Lesto` instance as the hand-written routes, inheriting their compilation,
matching, and typed params unchanged.

## Decision

Add an **opt-in** file-based routing convention — a strict subset of the
Next/Remix/SvelteKit family — that scans a conventional directory into ordered
route descriptors and registers them as ordinary `.page()` calls.

### The convention

```
app/routes/
  layout.tsx              → wraps every page below it
  page.tsx                → the route "/"
  about/page.tsx          → the route "/about"
  listings/
    layout.tsx            → wraps every page at or below /listings
    page.tsx              → the route "/listings"
    [id]/page.tsx         → the route "/listings/:id"  (typed param `id`)
```

- A **`page`** file makes its directory's URL a route; a **`layout`** file wraps
  every page at or below its directory (outermost-first nesting). Only `page` and
  `layout` base names count, with a SINGLE extension (`page.tsx`, `layout.ts`,
  `page.jsx`, …) — a co-located `card.tsx`, `page.test.tsx`, or `page.module.css`
  is never mistaken for a route.
- A **`[name]`** directory is a dynamic segment that compiles to `:name`, reusing
  the router's own param grammar — so the file convention inherits the SAME typed
  `c.param("name")` a hand-written `.page("/listings/:id", …)` gets, with no second
  inference path.
- The page module's `default` export IS its `PageDef` (`component` + optional
  `load`/`metadata`/`static`/`cache`); a layout module's `default` is the wrapping
  component handed its child as `children`.

### The split: pure descriptors vs. impure modules

The convention is deliberately factored so the path math is pure and 100% testable
with no filesystem, and the only impure parts (reading a directory, importing a
module) are injected seams:

1. **`@lesto/router` — pure.** `scanRoutes(readDir, root)` walks a convention dir
   (over an INJECTED `DirReader`, so a test hands a literal in-memory tree) into a
   flat `DiscoveredFile[]`. `compileFileRoutes(files)` turns those into ordered
   `FileRoute` descriptors: it derives each URL pattern (`[id]` → `:id`), computes
   each page's layout chain (the depths of every `layout` above it, shallowest
   first), refuses two pages at one pattern (`ROUTER_FILE_DUPLICATE_ROUTE`) and a
   malformed segment (`ROUTER_FILE_BAD_SEGMENT`), and returns pages **most-specific
   first** so a literal route shadows a dynamic sibling at the first differing
   segment under first-match resolution (`/listings/new` before `/listings/:id`,
   `/files/new` before `/:category/new`) with no hand-ordering.

2. **`@lesto/web` — impure over modules.** `applyFileRoutes(app, files, modules)`
   compiles the descriptors and registers each page onto the `lesto()` app, wrapped
   in its own per-branch layout chain (composed into the page's component, so the
   rest of the `.page` pipeline sees an ordinary `PageDef`). A descriptor whose
   module was not loaded is a wiring bug refused by code
   (`WEB_FILE_ROUTE_MODULE_MISSING`). `routeKey(kind, segments)` is the shared
   `"<kind>:<dir>"` key, so the loader and the applier index the same module the
   same way — and a `page` + a `layout` in one directory never collide.

3. **The loader (the app / bin) — the one place that touches `import()`.** A real
   filesystem `DirReader` (`fs.readdir(..., { withFileTypes: true })`) feeds the
   scan; a dynamic `import()` per discovered file builds the `modules` map. Because
   the scan and compile are pure and the applier is pure-over-modules, the whole
   convention is exercised under fakes; only this thin wiring is uncovered.

### Co-existence is the point

`applyFileRoutes` returns the SAME app, so a file route and a hand-written route
live on one router:

```ts
applyFileRoutes(lesto().get("/api/health", ok), scanned, modules)
  .post("/api/contact", submit);
```

## Consequences

- **One router, one typed-param story.** A `[id]` page is a `.page("/…/:id")`
  registration; nothing about matching, `c.param`, `load`, `static`, or `cache`
  changes. The convention is sugar, not a parallel engine.
- **Opt-in.** An app that never calls `applyFileRoutes` is byte-for-byte unchanged;
  there is no implicit scan, no magic directory the kernel reads on boot.
- **Portable.** Because the impure reader/loader are injected, the convention runs
  anywhere — Node's `fs` for the build/dev/test path, an in-memory tree for a test,
  a static descriptor list for a Cloudflare Worker isolate where `node:fs` is
  absent (how the estate demo keeps it edge-safe).
- **Demonstrated in estate.** `examples/estate/app/routes/` registers
  `/lab/gallery` and `/lab/gallery/:id` (a `layout.tsx`, a page, and a `[id]` page)
  purely by file path, composed onto the same router as the hand-written `/lab`
  routes; `test/file-routes.test.ts` runs the real `scanRoutes` over the directory
  and asserts it reproduces the registered descriptors, so the tree and the
  registration can never drift.

### Deliberately out of scope (for now)

- **Eager loading / `relations()`-style data co-location** — file routes register
  the same `PageDef.load` a code-first page uses; no new data convention.
- **Catch-all (`[...slug]`) and optional (`[[id]]`) segments** — the first cut is
  literal + single `[param]` only; the malformed-segment guard already refuses
  anything else by code, so adding them later is purely additive.
- **A `loading.tsx` / `error.tsx` convention** — streaming + error boundaries
  already exist on the `.page` path; folding them into the file convention is a
  future, additive step.

### Limitations & gotchas (the auto-scan + edge codegen, ADR 0027)

The CLI later grew an **auto-scan** (`lesto dev`/`serve`/`build`/`routes` apply
`app/routes/` with no wiring) and `generateRouteManifest` (a static-import manifest
for the edge, since a Worker has no `node:fs`; estate uses it instead of a
hand-written list). Two consequences an author must know:

- **Guards attach at the ROOT, not to a `.route()` scope.** Auto-discovered file
  routes register flat on the app and inherit its root `.use(...)` middleware (and
  the kernel's app-wide security stack) — but NOT the middleware of a mounted
  `.route("/admin", guarded)` sub-app. Dropping `app/routes/admin/page.tsx` does
  **not** inherit that sub-app's guard. Guard file routes at the app root (or with
  app-wide middleware); a per-directory guard convention is a future, additive step.
- **Static prerender still needs a `lesto.sites.ts` entry.** A file route renders
  live under `dev`/`serve`, but `lesto build` only prerenders the routes a static
  site's `pages` list names. A dropped-in page is served dynamically, not baked into
  the static output, until it is added to that list (auto-deriving the prerender set
  from the file tree is a future step).
