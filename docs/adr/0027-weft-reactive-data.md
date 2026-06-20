# ADR 0027 — Weft: a reactive data layer (explicit core, inference as an opt-in)

- **Status:** Proposed (revised 2026-06-20 after a 3-lens adversarial review — see *Adversarial review* below)
- **Date:** 2026-06-20
- **Deciders:** tech lead + owner
- **Builds on:** ADR 0005 (validation at the boundary), ADR 0012 (canonical island — data resolved at render and inlined, 0 RTT), ADR 0018 (relational data layer — typed `@lesto/db` queries), ADR 0022 (typed server mutations / `@lesto/client`), the existing `defineDataSource` primitive + `GET /__lesto/data/<name>` endpoint, and the planned (unbuilt) Postgres `LISTEN/NOTIFY` transport. Generalizes the island data-source primitive into an app-wide layer; does **not** replace it.

## Context

Lesto resolves the *first paint* well: a `.page` `load` runs on the server, an
`ssr:true` island inlines its data at render (ADR 0012, 0 RTT), and a typed
mutation changes state (ADR 0022). What it has **no** unified story for is the
*interactive data lifecycle* — re-running a query as inputs change, mutating with
optimistic feedback, invalidating the reads a write affected, going live, and
streaming. Today each is hand-wired.

The incumbents each solve a slice and leak the rest: **Remix / React Router** run
*route* loaders in parallel (no route-level waterfall) but can't see a component
buried in the tree; **Next App Router (RSC)** co-locates data but `await`-in-render
creates request waterfalls; **React Query / SWR** own the client cache but make you
hand-maintain query keys and call `invalidate` by hand; **Relay** solves
co-location-without-waterfalls and normalized caching, but only for GraphQL, with a
compiler tax; **Convex / Electric-SQL** give live queries as a separate runtime.

The opportunity is real: Lesto owns the query layer, the SSR, the island runtime,
and the build — the four seams a normal framework treats as black boxes. The
principle that pays it off:

> **Declare data, don't await it** — so the runtime can resolve a route's loaders
> in parallel and an author never writes a `fetch`-in-effect. **Accidental**
> waterfalls (the structural-coupling kind) disappear; an *intentional* data
> dependency (this read needs that read's result) still composes, explicitly.

That principle is sound and shippable today on primitives that already exist. A
**second**, far more speculative idea — *infer* the cache-invalidation graph from
each query's table set — is tempting but, on inspection of the real stack, is
neither free nor sound as a foundation (see *Adversarial review*). This ADR
therefore **builds the proven explicit core first** and treats inference as an
opt-in optimization, gated on evidence.

## Decision

Introduce **Weft**, a reactive data layer whose authoring unit is a **cell** — a
component co-located with a declared query — layered as four tiers, each shippable
and valuable on its own. Invalidation is **explicit or DB-sourced, never
app-inferred** in the core; inference is an opt-in optimization (Tier 3) that ships
only if it earns its runtime.

### Tier 0 — Authoring foundation (no new runtime; mostly already shipped)

The page-authoring ergonomics, which stand entirely on their own and are the
Next/Remix-parity fix that motivated this work. **Three separable increments**,
ranked by value-per-effort:

1. **Page-module shape** — `export default` is the component; `export const
   load` / `metadata` / `params` are named siblings. Small: `PageDef` already
   carries all of these (`render-page.tsx:66-124`) and `applyFileRoutes` already
   lifts a module's `default` (`file-routes.ts:118-143`); this is a thin loader
   adapter (`toPageDef`) that accepts the named-export form *and* the existing
   `default: PageDef` form. Component props infer from `PageProps<typeof load>`
   (`render-page.tsx:140`), which the named form finally makes reachable.
2. **Route-model binding** — `params = { post: bind(posts) }`: the segment is
   coerced to the column's type, the row is fetched in the loader phase, a miss is
   a 404, and `post` is typed as `Post`. Net-new (today `params` is a `ZodType`
   over the query string, `render-page.tsx:71,297-302`) — and the real ergonomics
   win. Kills the untyped `c.get("params")`.
3. **CLI auto-scan of `app/routes/`** — today `scanRoutes`/`applyFileRoutes` exist
   and are tested but **nothing calls them**; the scaffold emits no `app/routes/`,
   and estate hand-lists files + imports because a Worker has no `node:fs`
   (`examples/estate/src/file-routes-demo.ts:14-22`). Wiring this is **a
   build-time codegen step**: the CLI scans `app/routes/`, generates a static
   import map (so the edge bundle stays fs-free), and calls `applyFileRoutes`.
   This is compiler-adjacent engineering — sized honestly as the largest Tier-0
   item, not a freebie.

Per-branch *layout load* (layouts can declare their own `load`) is **deferred** —
it is the lowest-value item and overlaps with cells (a layout that needs data can
host a cell). It is not part of Tier 0.

### Tier 1 — Parallel composable loaders (Remix's model, on existing machinery)

Route, layout, and nested-route `load`s run in **one parallel pass** per matched
branch. `createSourceResolver` already runs declared loaders in parallel with
per-key memoization (`data-resolve.tsx:79-102`); generalize that memo to the
matched branch. This kills the route-level waterfall for the common case with
code that largely exists. Data is *declared* (a `load`), never fetched in an
effect — so there is no author-written waterfall.

**Honest scope:** this delivers co-location at the route/layout/nested-route
granularity, which covers the overwhelming majority of real needs. The
deeply-nested *arbitrary-component* co-located fetch (a `<Comments/>` five levels
down owning its own query) is served by `defineDataSource` islands today (inlined
at 0 RTT, ADR 0012) and is **not** a Tier-1 goal. We do not claim "waterfalls
structurally impossible" — we claim **no accidental route/sibling waterfalls; a
dependent read composes explicitly.**

### Tier 2 — Client cache with EXPLICIT invalidation (the proven core)

A small reactive store keyed by the **existing `@lesto/client` contract path**
(`"GET /mls/saved"` is already the key space, `client.ts:49-58`), seeded on the
client from the **existing** `defineDataSource` SSR inline (`IslandDataProvider`,
`data-resolve.tsx:104-120`) — so the dehydrate/hydrate bridge falls out for free,
no glue. A mutation declares what it invalidates:

```ts
const rename = defineMutation({ name: "renameListing", input, handler });
// invalidates: ["GET /mls/saved", "GET /mls/listings/:id"]
```

This is exactly what TanStack Query (`invalidateQueries`), SWR (`mutate(key)`),
SvelteKit (`invalidate(url)`), and Remix (loader re-run) ship — proven, bounded,
no inference. The store must stay within the preact-bundle budget (a hard
constraint, measured against the bundle-size gate).

**Authorization is first-class here, not assumed.** A cell/loader reachable by a
client is a public endpoint: `GET /__lesto/data/<name>` today enforces **no auth**
— it sets only a cache header (`lesto.ts:303-307`). Every client-callable cell
**must** declare `authorize(c)` (or be explicitly `public: true`); registration is
**fail-closed**. We do not inherit `.data()`'s "auth is the loader's problem"
model into a route-free layer.

### Tier 3 — Inferred invalidation (OPT-IN optimization, gated on evidence)

*Only after Tier 2 ships and the spike (below) passes*, let a cell **optionally**
derive its invalidation deps from its query's table set instead of writing them.
This requires net-new `@lesto/db` surface that does not exist today: the query
object exposes only methods, with its table(s) held in closure-private state
(`queries.ts:105-111, 361-372`) — so we must add a `tables` accessor on
`SelectQuery`/`JoinQuery` (derivable from the `membersOf` machinery at
`queries.ts:465`, today internal to JOIN compilation) and an un-terminated,
introspectable query form. Inference is **always coarse-to-fine and visible**:
pk-row reads → row-precise; filtered/joined reads → table-set (a known
over-invalidation cost, logged loudly); aggregates / derived / non-`@lesto/db`
reads → explicit deps (the Tier-2 default). Inference never *replaces* the
explicit path; it removes boilerplate for the cases where it provably holds.

**Why inference is not the foundation:** it is *unsound* as a global mechanism —
writes that bypass typed mutations are invisible to it. The queue writes raw SQL
(`queue.ts:383,451,496`), `db.raw`/`db.exec` are first-class (`queries.ts:714,
733`), and DB triggers / other processes on the same Postgres are categorically
invisible to an in-process JS graph. App-level table-set inference can therefore
silently miss writes. The sound source of "what changed" is the database itself
(Tier 4), not inference.

### Tier 4 — Live (DB-sourced invalidation)

When the transports land, a cell marked `live` re-runs on change. The change
signal comes from the **database** — Postgres `LISTEN/NOTIFY` (sound: the DB
reports the exact table/row that changed, including out-of-band writes) — routed
into the **explicit Tier-2 invalidation map** (read-X-invalidate-cells-reading-X),
*not* the app-inferred graph. This needs **two** unbuilt transports, named
honestly: (a) PG `LISTEN/NOTIFY` (the remaining §C realtime item; `@lesto/pubsub`
is in-process only today), and (b) a WS/SSE delivery layer to subscribed clients.
Last, and gated on both.

### The rendering mechanism (one model, scoped to reality)

We pick **one** mechanism, not two: cells **declare** loaders that the runtime
resolves **before** the component reads them, via the existing render-time
resolver pattern (`React.use()` over a memoized, parallel resolver,
`define-island.tsx:121`, `data-resolve.tsx:79-102`). The "same-tick SQL
coalescing in one transaction" claim is **dropped from the core** — the existing
resolver memoizes per source, not per batch, and cross-query coalescing/transaction
is unbuilt and edge-fragile (D1 `transaction` degrades to no-isolation,
`d1.ts:15-18`). Streaming (`defer`) rides the **React** `renderToReadableStream`
path (`stream.tsx:42`) that already exists; under the **preact dialect** the
server renderer is buffered with no streaming Suspense (`render-page.tsx:351-353`),
so `defer`/async-suspending cells are a **React-dialect feature** and the preact
path resolves cells before a buffered render. This is stated, not papered over.

### Consistency model (scoped to what the stack provides)

The core (Tiers 1-2) needs no row-versioning: explicit invalidation refetches; an
optimistic mutation patches the cache and rolls back on failure (a discriminated
result already exists, `mutations.ts:90-97`). The richer rules (last-writer-wins
by version, stale-response drop) are **deferred to Tier 4** and **require a version
token `@lesto/db` does not surface today** (no `xmin`/`updated_at`; `SELECT *` is
hardcoded, `queries.ts:247,258`). Adopting them means mandating an `updated_at`
projection — named as Tier-4 work, not assumed. "One-transaction page snapshot" is
**not** claimed on the edge (D1 gives no isolation); on Postgres it is optional and
must not be held across a streaming render (connection-pool risk).

## Non-goals

- No GraphQL; no RSC `use client` transform (routing-redesign memory).
- No arbitrary client SQL — cells are server-registered, called by id, **and
  authorized per cell**.
- No second database / no CRDTs. Live is DB-sourced invalidation, not offline-first
  replication.
- **Inference is not the core.** It is an opt-in optimization that never replaces
  the explicit/DB-sourced path.

## Phased plan

- **Spike 0 (throwaway, gates Tier 3).** A ~200-line static analyzer over
  `examples/estate`'s real queries: extract each query's table set (reuse
  `membersOf`/`tableName`), classify row-precise / table-set / falls-to-explicit,
  and tally the fast-path %. Needs **none** of the runtime. *Decision gate:* if
  inference rarely holds on real joins/aggregates, Tier 3 is descoped to
  explicit-only and the inference runtime is never built.
- **Ship A — Tier 0 (durable value, spike-independent).** 0.1 page-module shape
  (small), 0.2 `bind(model)` (the ergonomics win), 0.3 CLI scan + codegen import
  map (the real engineering — sized as such). Layout-load deferred.
- **Ship B — Tiers 1 + 2 (the proven data core).** Parallel composable loaders;
  the explicit-invalidation client cache keyed off `@lesto/client` and seeded from
  the `defineDataSource` SSR inline; per-cell `authorize` (fail-closed); typed
  mutations declaring `invalidates`. The cell-registration build step (stable ids,
  sibling to island discovery at `bun.ts:112`) is **named here**, up front, since
  both server-inline and client-call need it.
- **Ship C — Streaming (`defer`), React dialect.** Small, rides existing
  `renderPageStream`.
- **Ship D — Tier 3 (inference), only if Spike 0 passed.** The `@lesto/db`
  `tables` accessor + the opt-in derived deps over the Tier-2 core.
- **Ship E — Tier 4 (live).** Gated on PG `LISTEN/NOTIFY` **and** a WS/SSE
  transport; feeds the explicit map.

## Risks & open questions

- **Does inference earn its runtime?** Answered by Spike 0 *before* any inference
  code. The whole point of the re-foundation is that a "no" here costs a
  throwaway script, not a shipped runtime.
- **Client-cache bundle cost** vs the preact ethos — measured against the
  bundle-size gate, not assumed.
- **Per-cell authz discipline** — fail-closed registration is the hedge against the
  "every loader is a public endpoint" footgun; needs a good default and lints.
- **Layout-load vs cells** — deferred deliberately; revisit once cells exist.

## Adversarial review (what changed and why)

A 3-lens red-team (correctness / simplicity / sequencing), grounded in the tree,
found the original draft's headline — *schema-inferred invalidation as the
load-bearing foundation* — to be (1) **not implementable without unnamed new
`@lesto/db` APIs** (the query object hides its table set, `queries.ts:105-111`);
(2) **unsound**, because out-of-band writes (the queue's raw SQL `queue.ts:383`,
`db.raw` `queries.ts:714`, triggers, other processes) are invisible to an
in-process graph; (3) **imprecise** (list reads → table-set → thundering-herd
refetch); (4) **underspecified against the real renderer** (preact has no streaming
Suspense, `render-page.tsx:351`; "never block" vs "same-tick batch" conflated;
coalescing/one-transaction unbuilt and edge-fragile); (5) **missing per-cell
authz** (`/__lesto/data` enforces none, `lesto.ts:303`); (6) resting on **versioned
rows `@lesto/db` doesn't surface**; and (7) **mislabeling** ~70% of the product as
a "Phase 1 proof with zero new infrastructure," with Phase 0 bundling four
separable, mostly-already-shipped changes.

The revision inverts the bet: ship the **proven explicit core** (Tiers 1-2) on
primitives that already exist, source live invalidation from the **DB** (Tier 4),
and gate the speculative **inference** (Tier 3) behind a throwaway spike. The one
capability deliberately **dropped** vs the original: the deeply-nested
arbitrary-component co-located fetch and the "write-nothing auto-magic
invalidation" demo — honestly, the original's marketing centerpiece. The
mitigation: Remix/SvelteKit ship without it; `defineDataSource` islands cover the
deep-fetch case at 0 RTT; and inference can still arrive in Tier 3 if it proves
out. **Owner call to confirm:** demoting inference from foundation to opt-in is the
deliberate trade — override if you want the auto-magic graph as the headline
despite the soundness cost.

## Consequences

- Lesto ships a co-located, parallel-loader data layer with typed mutations and
  explicit (then DB-sourced) invalidation — proven, bounded, reusing what exists
  — and a credible, *evidence-gated* path to the differentiated inference + live
  story, instead of staking the foundation on the riskiest, least-built mechanism.
- Tier 0 delivers the Next/Remix ergonomics parity immediately and independently.
- `defineDataSource` (ADR 0012) becomes the degenerate case of a cell, folded in
  over time with back-compat preserved.
- The bet is de-risked by construction: every tier is independently valuable, and
  the one unproven idea is gated on a spike that costs nothing to run.
