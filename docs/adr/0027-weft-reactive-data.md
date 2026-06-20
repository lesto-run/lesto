# ADR 0027 — Weft: reactive data cells with an inferred dependency graph

- **Status:** Proposed
- **Date:** 2026-06-20
- **Deciders:** tech lead + owner
- **Builds on:** ADR 0005 (validation at the boundary), ADR 0012 (canonical island — data resolved at render and inlined, 0 RTT), ADR 0018 (relational data layer — typed `@lesto/db` queries), ADR 0022 (typed server mutations), the existing `defineDataSource` primitive + `GET /__lesto/data/<name>` endpoint, and the planned Postgres `LISTEN/NOTIFY` transport. Subsumes the island data-source primitive (`@lesto/ui`'s `defineDataSource` / `.data()`) into a general layer.

## Context

Lesto resolves the *first paint* well: a `.page` `load` runs on the server, an
`ssr:true` island inlines its data at render (ADR 0012, 0 RTT), and a typed
mutation changes state (ADR 0022). What it has **no** unified story for is the
*interactive data lifecycle* — the hard 80% every app hits the moment it stops
being a brochure: re-running a query as inputs change, mutating with optimistic
feedback, invalidating exactly the reads a write affected, going live, and
streaming. Today each is a separate, hand-wired concern.

The incumbents each solve a slice and leak the rest:

- **Remix / React Router** run *route* loaders in parallel (no route-level
  waterfall) but can't see a component buried in the tree, so its data is either
  hoisted to the route loader (coupling, over-fetch, prop-drilling) or fetched
  client-side (spinner + waterfall).
- **Next App Router (RSC)** co-locates data with the component but `await`-in-render
  creates *request waterfalls* — a parent's fetch must resolve before a child's
  even starts — patched by hand with `Promise.all`, `cache()`, and preloading.
- **React Query / SWR** own the client cache beautifully but make you hand-maintain
  **query keys** and call `invalidateQueries(['posts'])` by hand — the #1 source of
  stale-UI bugs — and need `dehydrate`/`hydrate` glue to bridge SSR.
- **Relay** solves co-location-without-waterfalls and normalized caching, but only
  for GraphQL, with a compiler and a schema-typing tax.
- **Convex / Electric-SQL** give live queries, but as a separate runtime/database.

The pattern: nobody **owns the four seams at once** — the query layer, the SSR, the
island runtime, and the build. Lesto does. That is the unfair advantage this ADR
spends.

The root cause of every waterfall footgun is the same: **data is fetched
imperatively, mid-render.** If a component instead *declares* what it needs as a
value the runtime can inspect before committing to render, the runtime can collect
a page's whole data graph and resolve it in one parallel pass — render never blocks
on I/O, so an *accidental* waterfall becomes structurally impossible. And because
the declared queries are typed `@lesto/db` expressions, the runtime can read the
**table set** each one touches — which is enough to derive the cache normalization
and invalidation graph **by inference, not by hand.**

## The principle

> **Declare data, don't await it — and infer the dependency graph from the types.**

Everything below falls out of that one sentence.

## Decision

Introduce **Weft**: a reactive data layer whose authoring unit is a **cell** — a
component co-located with a declared `query`. One cell declaration spans the entire
lifecycle (server → client → live → stream); the runtime derives the rest.

> Prior art, named honestly: the co-located-query *shape* echoes RedwoodJS Cells
> and the resolve-then-inline instinct is ADR 0012's. What is **new** here is the
> mechanism: SQL-native (no GraphQL/codegen), a cache **normalized by `(table, pk)`
> from the schema**, an **invalidation graph inferred** from each query's table set,
> automatic **batch + coalesce** across the whole tree, and one declaration that is
> also the live subscription and the stream. We are not copying Cells; we are taking
> the good idea and going where only an owns-the-stack framework can.

### The cell

```tsx
// components/Comments.tsx — usable at any depth, no route coupling
export const query = (c) =>
  db.select().from(comments).where(eq(comments.postId, c.parent.post.id)).all();

export function Comments({ data }: CellData<typeof query>) {  // data: Comment[], typed from the query
  return <ul>{data.map((m) => <li key={m.id}>{m.body}</li>)}</ul>;
}
```

- **Declare, don't await.** `query` is a declaration. The component reads `data`
  synchronously — it is already resolved. Render cannot block on I/O.
- **Same-tick batching.** Every query that becomes pending in one render pass is
  dispatched as **one parallel batch**. Depth ≠ waterfall. The *only* serialization
  is a query that consumes another's result (`c.parent.post.id`) — an intentional
  edge you wrote, never an accidental structural one.
- **SQL coalescing.** Seeing the whole batch before touching the DB, the runtime
  collapses N point-reads on a table into one `WHERE pk IN (…)` and runs the batch
  in **one transaction** — a consistent page snapshot, DataLoader's job done for you.
- **Normalized by `(table, pk)`.** Row-shaped results are stored normalized by
  primary key (we know the schema), so one row appears once in the cache and an
  update to it reflects in every cell that contains it — Relay's killer property,
  with zero normalization config.

### The five axes, one declaration

1. **First paint (server).** Cells resolve in the server batch and inline into the
   HTML *and* a serialized cache snapshot. The island boots with the cache
   pre-populated — instant first client render, no refetch, no loading flash. This
   is ADR 0012 generalized from one island to the whole tree, plus a free
   dehydrate/hydrate bridge.
2. **Client query.** A cell is a **server-registered function called by id** — the
   browser sends `{ cellId, inputs }`, never SQL; the server re-runs the registered
   query under the request's auth (so the client cannot read rows it shouldn't).
   Reactive inputs (`c.search`, `c.params`) re-run it; the key is a derived hash of
   `(cellId, inputs)`; the runtime dedupes in-flight and keeps-previous-data for
   flicker-free pagination. You never write a cache key.
3. **Mutation + inferred invalidation.** Built on ADR 0022. Because a cell's query
   is a typed `@lesto/db` expression, the runtime knows it reads `posts`; a mutation
   that writes `posts` automatically revalidates every cell that reads `posts` — and
   for pk-shaped reads, only the touched **rows**. The optimistic patch for a simple
   row write is *derived from the write itself*. No key bookkeeping, no manual
   `invalidate`.
4. **Live.** `export const live = true` turns the same cell into a live query. Over
   Postgres `LISTEN/NOTIFY`, a row change in a watched table pushes an invalidation
   to subscribed clients (WS/SSE); the cell auto-subscribes to its table set because
   the runtime already maps cell → tables.
5. **Stream.** `export const defer = true` lets a slow cell stream into the *same*
   response after the shell (React 19 streaming SSR, which `renderPageStream`
   already does) — no extra round trip. A cell whose query returns an async iterable
   / `ReadableStream` (e.g. `@lesto/ai`'s `streamText`) re-renders as chunks arrive.

### The consistency model (the genuinely hard part, resolved on paper)

A normalized store keyed by `(table, pk)` plus four rules:

1. **Versioned rows.** Every row result carries a logical version (an updated-at /
   xmin-style token surfaced by `@lesto/db`). The store keeps the highest version
   seen per `(table, pk)`; a write or live push with a lower version is ignored.
   Last-writer-by-version wins, deterministically.
2. **Optimistic patches are layered, not committed.** An optimistic mutation applies
   a patch tagged with a client-mutation-id *on top of* the authoritative store. The
   server's response (or a live push) reconciles by `(table, pk)`; the patch is then
   dropped. On failure the layer is removed — automatic rollback, no snapshot dance.
3. **Stale responses are dropped.** Every fetch/refetch is tagged; a response that
   resolves older than the latest applied write to its rows is discarded, killing
   the "refetch races a mutation and resurrects stale data" bug by construction.
4. **Coarse-to-fine invalidation, made visible.** (a) pk-row reads → row-precise
   invalidation; (b) filtered/joined reads → table-set invalidation (refetch cells
   whose table set intersects the write's); (c) aggregates / derived / non-DB cells →
   **explicit** `reads`/`invalidates` deps, or `manual`. The fast path is automatic;
   the tail is explicit; and the runtime **logs** when a cell falls to the coarse
   path, so the cost is loud, not silent (Lesto's "loud-when-wrong" ethos).

### Resolved design questions

- **Collection strategy:** runtime Suspense-style same-tick batching is the model
  authors write to — it is correct for conditional subtrees (only rendered cells
  fetch) and we own the renderer. A **build-time static hoist** (Relay-style, true
  single query) is a *later* optimization we can add *because we own the bundler*;
  it is not required for correctness.
- **Magic vs explicit:** explicit is the contract, convention is opt-in sugar.
  `params = { post: bind(posts) }` and a cell's table set (inferred from the typed
  query) are explicit/derived; a folder-name→model auto-bind is opt-in via config,
  never silent.
- **Inference boundary:** automatic for typed `@lesto/db` queries; a non-DB cell
  (external API) must declare its deps or be `manual`. Same fast-path / escape-hatch
  shape as boundary validation.
- **Client cache runtime:** a small normalized reactive store (Relay/React-Query
  shaped) that **must** stay within the preact-bundle budget — this is a hard
  constraint and a first-class part of the work, not an afterthought.

### The page module shape (the ergonomics fix that started this)

Default-export the component; named exports for the rest; everything typed from
everything else — and `params` bound to a model, which only we can type:

```tsx
// app/routes/posts/[post]/page.tsx — drop the file, it is a route (Phase 0 wires the scan)
export const params   = { post: bind(posts) };                 // coerced, fetched, 404'd, typed as Post
export const metadata = ({ post }) => ({ title: post.title });  // sees the bound row
export default function Post({ post }: RouteData<typeof params>) {
  return <><Article post={post} /><Comments /></>;             // Comments brings its own data, batched
}
```

## Non-goals

- **No GraphQL** and **no RSC `use client` transform** (routing-redesign memory) —
  Weft is the non-RSC, SQL-native path.
- **No arbitrary client SQL** — cells are server-registered; the client calls them
  by id. The query layer never reaches the browser.
- **No second database / no CRDTs** in v1 — live is `LISTEN/NOTIFY` invalidation, not
  offline-first replication. Last-writer-by-version, not multi-master merge.

## Phased plan

- **Phase 0 — Authoring foundation (no new runtime).** The page-module shape
  (default component + named `load`/`metadata`/`params`), **route-model binding**
  (`bind(model)` → typed/coerced/fetched/404'd params, killing the untyped
  `c.get("params")`), CLI **auto-scan of `app/routes/`** with a build-time import map
  (fs-free on the edge), and per-branch layout `load`. This is also the Next/Remix
  ergonomics parity from the rough-edges audit — it stands on its own.
- **Phase 1 — Thesis proof (no new transport).** The cell declaration resolving in
  the server same-tick batch + SQL coalescing + normalized store + inline-on-first-
  paint; typed mutations (ADR 0022) driving **inferred invalidation** on the client.
  Proves the inference + normalization thesis with zero new infrastructure. **This is
  what we build and pressure-test first.**
- **Phase 2 — Interactive client queries.** Reactive inputs, dedupe, keep-previous,
  pagination; soft-nav fetches the next page's whole graph in one request +
  prefetch-on-intent, over the generalized `/__lesto/data` endpoint.
- **Phase 3 — Streaming.** `defer` (slow cells stream into the same response) and
  stream-valued cells.
- **Phase 4 — Live.** `live: true` over Postgres `LISTEN/NOTIFY` (gated on that
  transport, the remaining §C differentiator).

## Risks & the make-or-break

- **Does inferred invalidation hold under real apps** — joins, aggregates, derived
  reads? If cells fall to the coarse/explicit path *often*, the magic is not worth
  the runtime. **This is the thesis Phase 1 must validate** before we commit to
  Phases 2-4. The tiered model + visible logging is the hedge.
- **Cache-runtime bundle cost** vs the preact ethos — measured against the
  bundle-size gate, not assumed.
- **Consistency edge cases** (optimistic ⨯ live ⨯ refetch interleaving) — the four
  rules are the design; Phase 1 proves them under test before Phase 4 adds live.
- **Two-render cost** of Suspense batching is CPU, not I/O — acceptable, and the
  build-time hoist is the escape valve if it bites.

## Consequences

- Lesto gets a data story no JS framework has end-to-end: co-location **and** no
  waterfalls, a cache that **invalidates itself from the schema**, one declaration
  that is query + mutation-target + live subscription + stream, and zero query keys
  / dehydrate glue / hand-rolled DataLoader.
- The island data-source primitive (`defineDataSource`, ADR 0012) becomes the
  degenerate case of a cell and is folded in over time (back-compat preserved).
- It is a real bet — a new runtime + a compiler-adjacent scan + a consistency model.
  We de-risk by phasing: Phase 0 ships pure ergonomics value immediately; Phase 1
  proves the thesis with no new infra; only then do we spend the transport work.
