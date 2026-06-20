# ADR 0027 — Page module shape (default-export component); reactive data layer deferred

- **Status:** Proposed (revised twice 2026-06-20 — a 3-lens red-team then a Chief-Architect fresh-eyes pass — each of which cut scope. See *Reviews* below.)
- **Date:** 2026-06-20
- **Deciders:** tech lead + owner
- **Builds on / touches:** ADR 0023 (file-based routing — `applyFileRoutes`, `LoadedRouteModule`), ADR 0012 (`defineDataSource` / island inline data), ADR 0022 (typed mutations / `@lesto/client`).

## Context

The concrete, demanded requirement: a file-based page must today
`export default` a **`PageDef` object** —
`const page: PageDef<…> = { component, load, metadata }; export default page`
(`examples/estate/app/routes/lab/gallery/page.tsx:25-50`). Next.js and Remix
instead `export default` the **component** and use named exports for the loader and
metadata. That extra ceremony is the rough edge to remove.

Separately, this work explored a **novel reactive data layer** ("Weft" — declarative
cells, an inferred cache-invalidation graph, live queries) to attack the
data-fetching waterfall/cache-invalidation pain other frameworks still have. That
exploration is recorded under *Deferred* below — but it is **not** what we build
now: two reviews found it has **no demanded requirement** behind it, that the
interactive cases are already covered by shipping primitives, and that its headline
mechanisms are either unsound or not "free." Building a new client-cache runtime now
would violate slow-iteration and add a large untested surface for no current user.

## Decision — build now: the page-module shape adapter (only this)

Add a `toPageDef` adapter in `packages/web/src/file-routes.ts` (where
`LoadedRouteModule` already lives, `file-routes.ts:46-48`) that lets a route module
take **either** shape, and wire it into `pageDefFor` where the default export is
read today (`file-routes.ts:118-121`):

```ts
// New idiomatic shape (the requested ergonomics):
export default function Posts({ posts }: PageProps<typeof load>) { … }  // the component
export const load = (c) => ({ posts: … });        // optional named loader
export const metadata = ({ posts }) => ({ … });   // optional named metadata
export const params = z.object({ … });            // optional (query-string Zod, unchanged)
// `static` / `cache` may also be named exports.

// Existing shape still works, untouched:
const page: PageDef = { component, load, metadata };
export default page;
```

- **Discriminator (pinned, so an implementer can't mis-fold):** if `module.default`
  is **callable** (a function component), assemble a `PageDef` from it plus the named
  exports (`{ component: module.default, load: module.load, metadata: module.metadata,
  params: module.params, static: module.static, cache: module.cache }`). If
  `module.default` is a **non-callable object** (it has a `component` field), use it
  as the `PageDef` verbatim — the existing path.
- **Props inference comes for free:** `PageProps<typeof load>` already infers the
  component's props from the loader's return (`render-page.tsx:140-142`); the
  named-export form is what makes it ergonomic to reach (no `PageDef<Path, Props>`
  restatement).
- **Back-compat by construction:** every existing `default: PageDef` page and
  estate's hand-wired demo (`examples/estate/src/file-routes-demo.ts`) keep working —
  the object branch is the current behavior unchanged.
- **Scope:** ~40 LOC + tests in `@lesto/web`; no new runtime, no new dependency, no
  new security surface, no change to rendering (`renderPageResponse` still receives a
  `PageDef`). Proof: convert estate's two gallery pages to the named-export form and
  update `file-routes-demo.ts`'s module wrapper. Testable to 100% as a pure function
  over a module shape, like the existing `pageDefFor`/`compileFileRoutes` tests.

That is the whole committed change. It directly removes the boilerplate the
requirement named, and nothing else.

## Deferred — not scheduled; each blocked on a real use-case

These were explored and are written down so we don't re-derive them — but none has
a demanded requirement, so none is built until a real app feels the pain.

- **Route-model binding (`bind(model)`).** Pitched as `params = { post: bind(posts) }`
  coercing a path segment to a column type, fetching the row, 404-on-miss, typed as
  `Post`. This is **net-new**, not "the same field richer": today `params` is a
  `ZodType` over the **query string** (`render-page.tsx:71,297-302`), separate from
  path params (`c.param("id")`). estate does the param→fetch→404 in two lines today
  (`[id]/page.tsx:28-32`). Revisit only if that pattern proliferates enough to fund a
  new typed coercion+fetch+404 mechanism.
- **CLI auto-scan of `app/routes/`.** `scanRoutes`/`compileFileRoutes` exist and are
  tested, but **nothing in the CLI calls them** (`bin.ts`/`run.ts` never import them);
  estate hand-lists files because a Worker has no `node:fs`. Wiring "drop a file → it
  routes" requires a **build-time codegen step** that emits a static, fs-free import
  map — a new CLI subsystem. High refactor risk; defer until drop-a-file routing is
  wanted badly enough to fund it. (Until then, `applyFileRoutes` is opt-in with a
  hand-written module map, as ADR 0023 shipped it.)
- **Layout `load`.** Layouts are children-only today (`render-page.tsx:44`). Adding
  per-layout data overlaps with the deferred data layer; revisit alongside it.
- **The reactive data layer ("Weft").** The explored design: declarative *cells*
  (a component + a co-located query); parallel composable loaders; a client cache;
  optional schema-inferred invalidation; DB-sourced live queries over the (unbuilt)
  PG `LISTEN/NOTIFY`. **Why deferred, not built:**
  - **No demanded requirement, and the cases that exist are already served** —
    co-located 0-RTT data by `defineDataSource` + the render-time resolver
    (`data-resolve.tsx:79-102`, `define-island.tsx:119-121`); typed
    mutations/optimistic by `@lesto/runtime` mutations + `@lesto/client`; typed reads
    keyed by contract path by `createApi` (`client.ts:49-58`). A new reactive store is
    additive machinery on top of three primitives that already cover today's needs.
  - **Corrected claims from the reviews (do not repeat them if this is revived):**
    (1) there is **no "free" SSR-hydrate bridge** — `defineDataSource` keys by bare
    source name (`hydrate.tsx:112-118`, `/__lesto/data/<name>`) while `@lesto/client`
    keys by `"METHOD /path"` (`client.ts:52-58`); bridging them is net-new glue, not
    free. (2) There is **no multi-loader-per-branch execution model** to "just
    generalize" — `renderPageResponse` runs exactly one `def.load`
    (`render-page.tsx:309`) and layouts compose as components, not loaders. (3)
    Schema-inferred invalidation is **unsound as a foundation** (out-of-band writes via
    the queue's raw SQL `queue.ts:383`, `db.raw` `queries.ts:714`, triggers, or another
    process are invisible to an in-process graph) and needs a `tables` accessor
    `@lesto/db` does not expose (`queries.ts:105-111,361-380`); the sound source of
    "what changed" is the DB itself (`LISTEN/NOTIFY`). (4) Per-cell `authorize()` is
    unspecified against the real middleware/CSRF model (`lesto.ts:142-157,289-308`) and
    is a security-sensitive hole to design properly **before**, not during, any build.
  - **If revived:** the smallest credible first step is an *explicit*-invalidation
    cache (author declares what a mutation invalidates — the TanStack/SWR/Remix model)
    layered on the existing `@lesto/client` keys, with live fed from `LISTEN/NOTIFY`
    into that explicit map. Inference, if ever, is a later opt-in gated on a throwaway
    coverage spike over a real app's queries — never the foundation.

## Non-goals

- No GraphQL; no RSC `use client` transform.
- No new client-side data runtime, cache, or cell system until a real use-case demands
  it. `defineDataSource` remains the data primitive.
- No change to the secure-by-default kernel, CSRF, or boundary validation.

## Reviews

- **Red-team (3-lens, grounded).** Found the original draft staked its foundation on
  schema-inferred invalidation, which is unimplementable without unnamed `@lesto/db`
  APIs, unsound for out-of-band writes, renderer-infeasible (no preact streaming
  Suspense), and missing per-cell authz. Cut: inference demoted from foundation to a
  spike-gated opt-in; live made DB-sourced.
- **Chief-Architect fresh-eyes pass.** Found that even the revised multi-tier plan was
  a ~40-line change in disguise: the interactive tiers are redundant with shipping
  primitives and unbacked by any requirement, and Tier 2's "free hydrate bridge" claim
  was false against the code. Cut: everything but the `toPageDef` adapter is deferred,
  not scheduled.

## Consequences

- We ship the exact ergonomics fix the requirement named — `export default` a
  component, named `load`/`metadata` — as a small, additive, fully back-compatible,
  100%-testable adapter, with no new runtime and no new attack surface.
- The reactive-data-layer thinking is preserved as a recorded, honest, deferred
  direction (with its falsified claims corrected), so it is neither lost nor
  prematurely built.
- Slow iteration upheld: one small change lands; the large, speculative surface waits
  for a real use-case to justify it.
