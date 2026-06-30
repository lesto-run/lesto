# ADR 0042 — Local-first sync (Tier 4 `lesto.live`): auth-scoped **data shapes** over Postgres logical replication → an OPFS-SQLite client store with optimistic offline writes

- **Status:** **Proposed** (drafted 2026-06-30). Pending the two-lens review (red-team +
  chief-architect) every substrate ADR goes through before ratification — this is a large,
  security-sensitive surface and must not be ratified unreviewed.
- **Date:** 2026-06-30.
- **Deciders:** tech lead + owner (scope was locked at the 2026-06-27 tech-lead intro — see
  *Context*).
- **Builds on / deliberately diverges from:** ADR 0027 (reactive data — explicit-topic
  invalidation; **the wire carries topics, never data**) and ADR 0040 (realtime transport — the
  topic bus + SSE fan-out; **`(topic, cursor)` only, never a row**). **This ADR is the OTHER
  product.** ADR 0027/0040 build *reactivity* (a push says "something you read is stale; refetch
  it through your authorized read"); this ADR builds *local-first sync* (the auth-scoped **rows
  themselves** stream to a client-side store the app queries locally and writes to offline). They
  contradict on the wire model on purpose: a topic bus that carried rows would re-introduce the
  exact per-row push-authorization problem ADR 0027 was designed to sidestep, so local-first is a
  **different wire and a different ADR**, as ADR 0040's non-goals already declared
  (`docs/adr/0040-realtime-transport.md` *Non-goals*, *Rejected alternatives #7*). It **reuses**
  ADR 0040's runtime long-lived-stream response kind (`packages/runtime/src/server.ts` `handleStream` /
  `isLongLivedStream`) and may ride the same `GET /__lesto/live`-class endpoint machinery, but the
  payload is rows, not topics.
- **Touches (seams, audited 2026-06-30):** the ORM query builder `db.select().from(t).where(...)`
  (`packages/db/src/queries.ts:150` `SelectBuilder`, `:5` the usage spine) — `live()` becomes a
  method here, the load-bearing moat claim; the Postgres adapter and its pooled
  `BEGIN`/`COMMIT` transaction bracket (`packages/pg/src/adapter.ts:102,114`) — the logical-
  replication slot is a *new, dedicated* connection beside the pool, like ADR 0040's dedicated
  `LISTEN` client; the principal + authorization seam (`packages/authz/src/principal.ts:91`
  `getPrincipal`, `guard.ts:94` `can`) — a **shape** is authorized at subscribe time and the
  authz is re-checked, the same hole ADR 0040 closed for topics (`L-85655d2c`); the client query
  cache `QueryClient` (`packages/ui/src/data-client.ts:86`, `registerTopics`/`invalidateTopic` at
  `:210`/`:244`) —
  the local store is the durable tier beneath it; the long-lived-stream runtime kind
  (`packages/runtime/src/server.ts`, ADR 0040) and `@lesto/realtime`'s SSE handler machinery
  (`packages/realtime/src/http-handlers.ts`); the queue (`@lesto/queue`) — offline writes
  reconcile through the existing mutation/queue path, not a bespoke sync server. Browser
  primitives: **OPFS-SQLite** (the durable client store), **Web Locks** + **BroadcastChannel**
  (cross-tab leader election + fan-out), `navigator.storage.persist()`. New package(s): a client
  **`@lesto/live`** (the store + sync client) and a server **shape engine** (likely inside or
  beside `@lesto/realtime`). Board: this ADR is `L-51bf0724`, the committed "next epic" under the
  local-first project (`lesto-local-first-sync-tier-4`, `6cf0dc74`).

## Context

At the 2026-06-27 tech-lead intro the owner **locked the scope**: reactivity (ADR 0027) ships now
as a pre-1.0 headline; **true local-first is a separate, committed next epic with its own ADR** (this
one). The headline finding that forced the split: ADR 0027/0040 and Tier 4 are *two different
products under one ambition*, and they **contradict on the wire**:

- **ADR 0027 / 0040 — reactivity.** A writer declares a dirty *topic*; a push carries the topic and
  a cursor, **never row data**; the subscriber drops the topic and **refetches through its existing
  authorized read**. This is sound (no inference), secure (the push carries nothing to leak, and the
  refetch re-authorizes via `.use(can())`/CSRF), and cheap. Its IndexedDB "cache" (ADR 0027 Phase 3)
  is a *stale-read cache*, explicitly **not** a sync engine.
- **Tier 4 — local-first** (`docs/PERF-SECURITY-2026.md:151-160`, *"the moat"*). The client holds a
  real, queryable replica of an auth-scoped slice of the database; it reads it **locally** (zero
  round-trip, offline-capable) and **writes** to it optimistically while offline, reconciling later.
  This requires the **rows themselves** on the wire — which re-introduces per-row push authorization,
  the problem ADR 0027 sidestepped by never shipping data. So local-first cannot be bolted onto the
  topic bus; it needs its own wire, its own change source, and its own authorization model.

The substrate as it actually is (audited): `@lesto/db` is a real query builder
(`db.select().from(t).where(eq(...))`, `queries.ts:150`); `@lesto/pg` is a pooled adapter with no
replication tap yet (`adapter.ts`); `@lesto/realtime` (ADR 0040, just landed) is a topic transport
with a dedicated long-lived listening client, a replay ring, and an SSE fan-out over the runtime's
new long-lived-stream response kind; the client has a key-cache `QueryClient` but no durable store.
The browser has OPFS-SQLite, Web Locks, and BroadcastChannel natively.

**Why this is the moat (the load-bearing strategic claim).** Every Postgres sync engine
(Electric, Zero, PowerSync) requires a database to tap, and an *app framework* has no substrate of
its own, so it can only *consume* an external sync service. Lesto owns the ORM, the migrator, the
queue, and the auth model on **one** Postgres — so `live()` can be a **method on the same query
builder** the app already uses: `db.select().from(messages).where(eq(messages.roomId, id)).live()`.
Local-first becomes **a property of the substrate, not a bolted-on service.** That is the thing no
app framework can coherently match, and the reason this is worth a hard, separate ADR.

## Decision

### `live()` is a method on the ORM query — the shape is the unit of sync

A **shape** is a named, parameterized read query plus the principal it is evaluated for — e.g.
`messages WHERE room_id = :roomId`, for *this* user. It is produced by the existing query builder:

```ts
const messages = db.select().from(messagesTable).where(eq(messagesTable.roomId, roomId)).live();
//    ^ a LiveQuery<Message[]> — reads from the local store, stays in sync, writable offline
```

`live()` does not execute a one-shot `SELECT`; it **registers a shape** with the server's shape
engine and returns a reactive handle backed by the **local store**. The same SQL the builder would
have sent is the shape's definition — so the shape's `WHERE` is both the *sync filter* (which rows
stream) and, crucially, the *authorization boundary* (see below). This is the moat claim made
concrete: the developer writes one ORM query and gets a synced, offline-capable, locally-queryable
result, with no socket code and no second query language.

### The wire carries auth-scoped **row data and diffs**, keyed by the commit **LSN**

Unlike ADR 0040's `(topic, cursor)`, the Tier 4 wire carries:

1. an **initial snapshot** — the rows matching the shape for this principal, at a known LSN; and
2. a **change stream** — inserts/updates/deletes to those rows, each stamped with the Postgres
   **commit LSN** as the authoritative, fleet-global, commit-ordered cursor.

The LSN is what ADR 0040 could *not* use (Postgres `LISTEN/NOTIFY` exposes no usable global
sequence, forcing ADR 0040's node-local `(instanceId, generation, index)` cursor + resync-by-
default). **Logical replication exposes the LSN directly**, so Tier 4 gets a sound, fleet-global
resume cursor for free: a client reconnecting presents its last-applied LSN and the server replays
the changes since it (or re-snapshots if the LSN has aged past the slot's retention).

### The change source is Postgres **logical replication**, not `LISTEN/NOTIFY`

A **dedicated logical-replication connection** (a replication slot + `pgoutput`/`wal2json` decoding)
streams *every* committed change with its row image and LSN — beside the pool, never from it (a
replication connection is special and long-lived, the same discipline as ADR 0040's dedicated
`LISTEN` client, `adapter.ts`). `LISTEN/NOTIFY` is rejected here for the same reasons it was *right*
for ADR 0040 and *wrong* here: it carries no row data, no ordering usable as a cursor, and an 8 KB
payload cap. Logical replication is the substrate's real "what changed, with the data, in commit
order" feed — exactly what a sync engine needs.

### Per-row authorization — the hard problem ADR 0027 sidestepped, solved by **shape predicates**

Shipping rows means the server must decide, for **every changed row**, whether *this* principal may
see it. This is the per-row push-authz problem ADR 0027 avoided by shipping topics. Tier 4 confronts
it directly with a layered model:

- **The shape's `WHERE` is the authorization predicate.** A principal subscribes to a shape; the
  server only ever evaluates and streams rows that satisfy that shape's predicate **for that
  principal** (the principal's id/org/tenant is bound into the predicate parameters server-side,
  never client-supplied). A shape a principal is not allowed to open is refused at subscribe time
  via the existing authz seam (`can()` / a net-new shape-authz check, the Tier-4 analogue of ADR
  0040's `L-85655d2c`).
- **A changed row is matched against every active shape's predicate before it is sent**, and only to
  the connections whose principal authorizes that shape. A row that moves *out* of a shape (an update
  that fails the predicate) is sent as a **delete-from-shape** (the client removes it), and a row
  that moves *in* is an insert — so the client's local slice stays exactly the authorized set, with
  no leakage of rows the principal lost access to.
- **Re-authorization is continuous, not connect-time-only** (the ADR 0040 lesson): a long-lived sync
  connection re-resolves session validity on an interval and is severed on revocation/expiry, and
  membership-changing writes (a user removed from a room) propagate as delete-from-shape.
- **Row-level filtering happens in the app/shape engine, where the principal lives — never in the
  database's replication output** (the replication stream is the full, unfiltered change feed; the
  shape engine is the authorization point). This keeps authz in one auditable place and off the DB.

This is the genuinely hard, genuinely new part of Tier 4, and the reason it is a separate ADR rather
than an extension of the topic bus.

### The client store is **OPFS-SQLite** (opt-in), queried locally; in-memory by default

The synced rows land in a client-side store the app queries with the **same** query semantics it
uses server-side:

- **Default: in-memory** (a structured store) — zero setup, lost on reload, fine for live views.
- **Opt-in: OPFS-SQLite** (`sqlite-wasm` over the Origin Private File System) — a real durable SQLite
  the app queries locally, surviving reload and enabling offline reads. `navigator.storage.persist()`
  requests durable storage so the browser does not evict it under pressure.

`live()`'s reactive handle re-runs its query against the local store whenever the store changes, so a
component re-renders from local data with no network round-trip. The existing `QueryClient`
(`data-client.ts:86`) sits **above** the store as the in-component cache; the store is the durable
tier beneath it.

### Optimistic **offline writes**, reconciled through the existing ORM/queue

A write while live is **applied to the local store immediately** (optimistic) and appended to a
**local mutation log**. When online, the log is drained through the **existing typed-mutation / queue
path** (`@lesto/queue`, the app's authorized `POST` mutations) — *not* a bespoke sync-write server,
so every write still passes the app's validation and authorization. The server's authoritative result
(via the replication stream) **reconciles** the optimistic local state: a confirmed write is a no-op,
a rejected write is rolled back locally, and a conflicting write resolves by **last-write-wins by
default**, with **Yjs/Loro per-field CRDTs as an opt-in later** (deliberately not v1 — most apps do
not need field-level merge, and CRDTs are a large surface). The reconciliation point is the ORM, the
moat again: the same models, the same queue, the same auth.

### Cross-tab: one leader syncs, the rest mirror

Multiple tabs of one origin must not each open a sync connection (the HTTP/1.1 6-connection cap, the
server fan-out cost). **Web Locks** elect a single **leader tab** that owns the sync connection and
writes the (shared, OPFS) store; **BroadcastChannel** fans store-change notifications to follower
tabs, which re-query the shared local store. Leader failover is automatic when the lock releases (the
leader tab closes). This mirrors ADR 0040's "one connection, many consumers" but moved entirely
client-side.

### Transport: a CDN-cacheable snapshot + a live tail on the long-lived-stream kind

- The **initial snapshot** for a shape at an LSN is an idempotent, **CDN-cacheable** HTTP response
  (same shape + same LSN ⇒ same bytes ⇒ cacheable/`ETag`-able) — many clients opening the same public
  shape share one cached snapshot. **Caveat (review must pin this down):** byte-identical responses
  require a **deterministic row order** — a `SELECT` without `ORDER BY` may return rows in a different
  order across executions (planner/stats/vacuum), defeating the cache. A shape definition must therefore
  carry a total ordering (e.g. `ORDER BY` a unique key); the snapshot serializer enforces it.
- The **live tail** is a long-lived stream that **reuses ADR 0040's runtime response kind**
  (`handleStream` / `isLongLivedStream`, `packages/runtime/src/server.ts`): no in-flight slot, no
  compression-buffering, bounded by the dedicated stream semaphore + per-IP cap. The Tier 4 endpoint
  is app-mounted exactly like `@lesto/realtime`'s SSE handler, reading the principal from context.
- **Read-your-writes / replica lag** is handled by the LSN: a client never accepts a snapshot older
  than an LSN it has already applied, and an optimistic write is held until the replication stream
  confirms it at a `>=` LSN.

### Phasing

- **v0 (dogfood, dev-loop parity):** **single table + simple equality/range filters**, with
  **SQLite-local polling/triggers standing in for logical replication** so the dev loop on SQLite
  matches the prod shape (the `docs/PERF-SECURITY-2026.md` v0 line). In-memory client store, online-
  only, last-write-wins. Proves `live()` end-to-end on the gallery. **Cursor parity is API-only, not
  semantic:** SQLite has no LSN, so v0 **resyncs on every reconnect** (no precise replay) — the `live()`
  *surface* is identical to prod, but the resume guarantee is the coarse floor until the v1
  logical-replication LSN lands. The dev/prod delta is stated, not hidden.
- **v1 (the real engine):** Postgres logical-replication tap, the shape engine with per-row predicate
  authz + re-auth, OPFS-SQLite durable store, offline mutation log + reconcile, cross-tab leader.
- **vNext:** multi-table / joined shapes, Yjs/Loro per-field CRDTs, edge fan-out (a Durable Object
  holding shapes for a key range — the Tier 4 twin of ADR 0040's deferred Phase C).

## Non-goals

- **Not the reactivity product.** ADR 0027/0040 (topic invalidation) stand and ship first; Tier 4
  does not replace them. An app may use reactivity for most views and `live()` only where local-first
  pays (offline, instant local reads).
- **No general client-side database / sync-any-query in v1** — shapes are bounded (single-table,
  simple filters) to start; arbitrary joined live queries are vNext.
- **No CRDT/collaborative-editing engine in v1** — last-write-wins is the default; Yjs/Loro is an
  opt-in per-field follow-up.
- **No bespoke sync-write server** — writes reconcile through the existing ORM/queue/auth, never a
  parallel write path that could bypass app authorization.
- **No row data on the ADR 0040 topic wire** — that invariant is preserved; Tier 4 is a separate
  endpoint and wire.
- **No background-sync (Service Worker) dependency** (`docs/PERF-SECURITY-2026.md`) — sync runs in
  the leader tab, not a background-sync registration.

## Rejected alternatives

1. **Extend the ADR 0040 topic bus to carry rows.** Re-introduces per-row push authz, violates ADR
   0027's no-data invariant, and forfeits the LSN (the topic bus has no global cursor). The clean
   split — topics for reactivity, a separate data wire for local-first — is the whole point.
2. **`LISTEN/NOTIFY` as the change source.** No row data, no usable global cursor, 8 KB cap. Right for
   ADR 0040 (topics), wrong for Tier 4 (data + ordering). Logical replication is the substrate's real
   change feed.
3. **Consume an external sync service (Electric/Zero/PowerSync) as a dependency.** Forfeits the moat:
   the differentiator is `live()` being a method on the *same ORM* over the *same* Postgres, with the
   *same* auth and queue — not a second system bolted alongside. (Their designs are studied and
   credited; the position is "substrate-native, not bolted-on.")
4. **Client-supplied filters as the authorization boundary.** A client that picks its own `WHERE`
   could request rows it may not see. The shape's predicate is **server-evaluated for the bound
   principal**; the client names a shape, it does not author the authz predicate.
5. **Ship the full table and filter on the client.** Leaks every row to every client and defeats
   auth-scoping. Filtering is server-side, per-shape, per-principal.
6. **CRDTs (Yjs/Loro) as the v1 conflict model.** Large surface, unneeded by most apps; last-write-
   wins is the sane default, CRDTs an opt-in per-field follow-up.
7. **A Service-Worker background-sync engine.** Cross-tab leader election (Web Locks) + an in-page
   sync loop is simpler, debuggable, and avoids SW lifecycle hazards; explicitly a non-goal.

## Consequences

- Lesto gains a **substrate-native local-first** capability no app framework can match: `live()` on
  the ORM, auth-scoped, offline-capable, reconciled through the existing queue — the stated moat.
- A new server **shape engine** (logical-replication tap + per-shape/per-principal row authz) and a
  client **`@lesto/live`** store + sync client; the runtime long-lived-stream kind and the
  `@lesto/realtime` SSE machinery are **reused**, not rebuilt.
- The hardest new risk is **per-row authorization correctness** (a row leaking across a shape
  boundary, or a membership change not propagating as a delete-from-shape) — it must be the focus of
  the review and carry an adversarial, multi-tenant test matrix as an acceptance gate.
- A second operational dependency on Postgres (a replication slot — disk retention, slot-lag
  monitoring) that the deployment guide must cover; SQLite remains dev/single-node via the v0
  poll/trigger stand-in.
- Clear separation preserved: ADR 0027/0040 own *reactivity* (topics, no data); this ADR owns
  *local-first* (auth-scoped data). The `docs/brand/messaging.md` guardrail (`L-e819c686`) — claim
  "live queries" now, "local-first" only when this lands — is upheld.

## Acceptance criteria (the bar, when built)

- **Shape authz:** an adversarial multi-tenant matrix — a principal opening another tenant's shape is
  refused; a row that updates *out* of a principal's shape is delivered as delete-from-shape (never
  silently retained); a revoked session's sync stream is severed; a membership change propagates as a
  removal. **This matrix is the gate.**
- **Sound resume:** a reconnect from a stale LSN replays exactly the missed changes, or re-snapshots
  when the LSN aged past slot retention — never silently misses a change (the Tier-4 analogue of ADR
  0040's missed-message guarantee, now LSN-exact).
- **Offline writes:** a write made offline is applied locally, survives reload (OPFS), and reconciles
  through the real queue/auth on reconnect; a server-rejected write rolls back locally.
- **Cross-tab:** exactly one tab holds the sync connection; a follower tab re-renders from the shared
  store via BroadcastChannel; leader failover on tab close.
- **Dev-loop parity:** the v0 SQLite poll/trigger stand-in exposes the *same* `live()` API as the
  prod logical-replication path, proven by one `examples/` app that runs locally and deploys
  (gallery-as-QA-gate).

## Review

**Not yet reviewed.** Like every substrate ADR (0027, 0040, 0028…), this must pass a **red-team +
chief-architect** two-lens review grounded in the cited seams before ratification — with particular
adversarial focus on the per-row/per-shape authorization model (consequence + acceptance gate above),
which is the new, security-sensitive heart of the design. Draft only.
