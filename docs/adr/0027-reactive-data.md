# ADR 0027 — Reactive data, incrementally: a LISTEN/NOTIFY-fed explicit-invalidation cache

- **Status:** Accepted (revised 2026-06-22). **Supersedes** this ADR's prior
  "reactive data layer deferred" stance. Reactivity now has a demanded requirement
  — competitive parity with Convex / Supabase Realtime, and agent-native live views
  — so we build it, but **incrementally**: a thin layer over primitives we already
  ship, in phases that each land and pay off on their own. We do **not** ship a
  finished reactive runtime on day one, and we do **not** make schema-inference the
  foundation (the 2026-06-20 reviews were right that it is unsound — see *Rejected*).
- **Date:** 2026-06-20 (page-shape adapter) · revised 2026-06-22 (reactivity plan).
- **Deciders:** tech lead + owner.
- **Builds on / touches:** ADR 0022 (typed mutations / `@lesto/client`), ADR 0012
  (`defineDataSource` / island inline data), ADR 0023 (file routing). Concrete seams:
  `@lesto/ui` data-client `useQuery`/`useMutation`/`QueryClient.invalidate`
  (`packages/ui/src/data-client.ts:158`), `@lesto/client` `"METHOD /path"` keys
  (`packages/client/src/client.ts:52`), `@lesto/pubsub` `publish`/`subscribe`
  (`packages/pubsub/src/pubsub.ts`). Depends on board tasks `L-ee9433f8` (PG
  `LISTEN/NOTIFY` transport) and `L-dd3cdca1` (realtime browser fan-out).

## Context

The earlier revision of this ADR deferred reactivity because it had "no demanded
requirement" and its interactive cases were "already served by shipping primitives."
The Convex/Supabase competitive review (2026-06-22) is the use-case trigger that
deferral named: reactive queries — *change the data, the UI updates, with no
websocket plumbing in app code* — are the single most-loved capability we lack.

We are not starting from zero. We already have:

- **A client query cache with explicit invalidation.** `@lesto/ui`'s `useQuery` /
  `useMutation` cache results by key; `QueryClient.invalidate(key)` drops a key and
  refetches every mounted reader (`data-client.ts:158`). Its own doc-comment already
  reserves the boundary: *"Explicit-only — a mutation names the keys it dirties;
  there is no inferred invalidation."* That is the design, not an accident — this
  ADR formalizes it.
- **A contract-typed fetch keyed by `"METHOD /path"`** (`@lesto/client`).
- **A channel pub/sub API** (`@lesto/pubsub`) whose in-process hub is about to gain
  a Postgres `LISTEN/NOTIFY` transport under the same `publish`/`subscribe` surface
  (`L-ee9433f8`), with a browser fan-out over WebSocket/SSE (`L-dd3cdca1`).

So "reactivity" is not a new runtime — it is **invalidation, delivered first locally,
then over the wire**, on the cache and transport we already have.

## Decision

Reactivity is **explicit invalidation**. The spine, held across every phase:

> **The writer declares what it dirties. A change publishes an invalidation
> *topic* — a key/channel string — never row data. A subscriber maps the topic to
> its cache key(s), drops them, and refetches through the normal authorized
> endpoint.**

This one rule buys all three properties the rejected design failed on:

- **Sound** — invalidation comes from the writer declaring intent, not from an
  in-process graph inferring it (which is blind to out-of-band writes; see *Rejected*).
- **Secure** — the push carries no data, so it needs no per-row authz: data only ever
  returns through the existing authorized read (`can()` re-runs on every refetch; CSRF is
  irrelevant — a refetch is a GET, not a mutation). No-data-on-the-wire is necessary but
  not sufficient; two obligations make it real. **(a) Subscription is authorized** — the
  fan-out only lets a connection subscribe to topics its principal may observe. A topic
  like `org:123:posts` otherwise leaks *when* a tenant's data changes (a cross-tenant
  timing side-channel) even with no payload. **(b) Tenant topics are principal-scoped**;
  only genuinely public data rides an unauthenticated topic.
- **Cheap** — a `NOTIFY` payload (~8 KB cap) carries a topic, never a record.

Each phase is independently shippable and useful.

### Phase 0 — page-module shape (shipped, historical)

The prior scope of this ADR number: the `toPageDef` adapter letting a route module
`export default` the **component** with named `load`/`metadata` exports
(`7f293d3`), plus Node `app/routes/` auto-scan (`84e1411`) and edge route codegen
(`2922b7e`). Done; retained here only for provenance. Thin remainder: wire
`generateRouteManifest` into the bare `lesto build` + scaffold `worker.ts`.

### Phase 1 — explicit invalidation, client-local (mostly built; formalize)

Two symmetric declarations over the cache that already exists in `@lesto/ui`
(`data-client.ts`):

- A **mutation declares the topics it dirties** — `invalidates: ["posts", …]` (or a
  `useMutation` option) — instead of callers hand-calling `QueryClient.invalidate`.
- A **query declares the topics it subscribes to** — `useQuery(key, fetcher, { topics:
  ["posts"] })`. The `QueryClient` keeps a small **topic → keys** registry; invalidating
  a topic drops every key registered under it and refetches. The TanStack/SWR/Remix model.

Crucially this does **not** unify the keyspaces. `useQuery` keys are arbitrary
(`serializeQueryKey`, data-client.ts:57), `@lesto/client` keys by `"METHOD /path"`
(client.ts:52), and `defineDataSource` seeds by bare source name (`hydrate.tsx`) — three
independent keyspaces. The prior reviews already ruled that bridging them is net-new glue,
**not free** — so we don't. The addressable unit is the **topic**, decoupled from any key
format, and a topic is all Phase 2 needs to target a push. (SSR-hydrate *seeding* — paint
`useQuery`'s first value from the page's `__lestoData` payload — is a separate, explicitly
optional, *local* concern a page opts into per key; it is NOT a global key contract and is
not on Phase 1's critical path.)

Also in Phase 1, independent of the invalidation spine: **background revalidation** —
`staleTime`, refetch-on-focus, refetch-on-reconnect, optional `refetchInterval` (all
opt-in; focus/online/timer events behind an injected seam). Splittable if P1 grows heavy.

No server, no transport. Delivers a clean, drift-resistant client cache today.

### Phase 2 — server-pushed invalidation over LISTEN/NOTIFY (the live moment)

Depends on `L-ee9433f8` (transport) + `L-dd3cdca1` (browser fan-out) + Phase 1.

A server mutation `publish`es an invalidation **topic** to `@lesto/pubsub` (now
`LISTEN/NOTIFY`-backed) **on commit, not before** — Postgres `NOTIFY` is delivered at
commit by default; the in-process/SQLite path must sequence the publish *after* the write
commits, so a subscriber's refetch cannot race the writer and re-cache pre-write state.
The fan-out delivers the topic to subscribed browsers — **authorizing each subscription
against the connection's principal** (see *Secure*) — and the client's topic → keys
registry (Phase 1) invalidates the matching keys → `useQuery` refetches through its
authorized read. `useQuery` is now **live across tabs, clients, and processes, with zero
websocket code in the app** — Convex/Supabase-Realtime parity, on plain Postgres, with
explicit topics. A client receiving its own mutation's topic just refetches once more
(idempotent; no special-casing). **Edge tier:** Durable Objects are the fan-out point
(owned by the transport/realtime ADRs).

### Phase 3 — durable client cache (IndexedDB), parallel track

Persist the `QueryClient` cache to IndexedDB so cold loads render last-known data
instantly and reads survive reload/offline. On reconnect, reconcile: drain missed
invalidation topics (or honor a coarse "refetch — you were offline" signal) so a
disconnect can't leave the UI stale. Independent of Phases 1–2 (a local enhancement)
but also what makes Phase 2 robust across disconnects. Tracked separately.

### Phase 4 — inference, opt-in and spike-gated (NOT now)

Only after Phases 1–2 are real and a live app's query set is measured: an **opt-in**
where a query declares its table deps and a mutation auto-derives topics from the
rows it wrote (needs a `.tables` accessor `@lesto/db` does not yet expose). Out-of-band
writes (queue raw SQL `queue.ts:383`, `db.raw` `queries.ts:714`, triggers, other
processes) stay the writer's explicit responsibility — or, the sound long-term source,
a DB trigger that `NOTIFY`s. Inference is **never** the foundation; explicit topics
always work underneath it.

## Non-goals

- No schema-inferred invalidation as the foundation. No GraphQL, no RSC `use client`
  transform, no bespoke "cell"/component-query runtime.
- **The push channel never carries row data** — only invalidation topics. Data flows
  exclusively through the authorized fetch.
- No change to the secure-by-default kernel, CSRF, or boundary validation.

## Rejected alternative — the original inference-first design

The 2026-06-20 draft staked its foundation on declarative *cells* + a **schema-inferred**
invalidation graph + DB-sourced live queries, built all at once. Two reviews
(3-lens red-team + Chief-Architect) cut it. Keep these corrections so they are not
re-derived:

1. **No "free" SSR-hydrate bridge** — `defineDataSource` keys by bare source name
   (`hydrate.tsx:112`), `@lesto/client` by `"METHOD /path"` (`client.ts:52`), `useQuery`
   by an arbitrary key (`data-client.ts:57`): three keyspaces. Unifying them is net-new
   glue — so this revision does **not**; the **topic** is the addressable unit (Phase 1)
   and SSR seeding stays an optional, local concern.
2. **No multi-loader-per-branch model to "just generalize"** — `renderPageResponse`
   runs exactly one `def.load`; layouts compose as components, not loaders.
3. **Schema-inferred invalidation is unsound as a foundation** — an in-process graph
   is blind to out-of-band writes (queue raw SQL, `db.raw`, triggers, other processes)
   and needs a `.tables` accessor `@lesto/db` lacks. The sound "what changed" source is
   the DB itself (`LISTEN/NOTIFY`) — which is exactly what this revision builds on.
4. **Per-cell `authorize()` was unspecified** against the real middleware model — a
   security hole. The explicit-topic spine narrows it to two stated obligations: the push
   carries no data (refetch re-authorizes the read), and **subscriptions are authorized**
   against the principal so topics don't leak change-timing (see *Secure*).

Why explicit-first wins: it is sound and secure by construction, it reuses the cache
and transport we already ship, and it lands in small useful increments — upholding
slow iteration while still reaching live-query parity at Phase 2.

## Consequences

- Reactivity arrives in shippable steps, not a big-bang runtime. Phase 1 is mostly
  already in the code; Phase 2 reaches Convex/Supabase-Realtime parity on Postgres;
  Phase 3 adds offline/instant cold-load; Phase 4 keeps inference available later
  without ever being load-bearing.
- The competitive gap (live queries) closes on terrain Convex can't follow onto —
  real SQL, a full framework, an edge tier — without abandoning the discipline that
  the 2026-06-20 reviews enforced.
- The rejected inference-first design is preserved, with its falsified claims
  corrected, so it is neither lost nor prematurely built.

## Review — 2026-06-22 (red-team)

A hostile pass over this rewrite, grounded in the seams, changed four things and left the
spine intact:

- **Subscription authz (security).** "No data on the wire" is necessary, not sufficient —
  an unauthorized subscriber to `org:123:posts` learns change-*timing*. The fan-out now
  must authorize subscriptions against the principal; tenant topics are principal-scoped.
- **Dropped the cross-layer key unification.** It was the net-new glue the prior reviews
  rejected, smuggled back as "small," and unnecessary: a query/mutation declares its
  *topics* (keys stay arbitrary), which is all Phase 2 needs to target a push. Phase 1
  shrinks back to honestly "mostly already in the code."
- **Publish on commit.** Stated the ordering so a refetch can't race the writer and
  re-cache pre-write state.
- **CSRF precision.** A refetch is a GET; `can()` re-authorizes it — CSRF does not apply.

No materially simpler whole-cloth alternative survived: the spine (explicit invalidation,
topic push, authorized refetch) is already the minimal sound shape, and inference stays
rejected.
