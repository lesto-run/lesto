# ADR 0042 — Local-first sync (Tier 4 `lesto.live`): auth-scoped **data shapes** over Postgres logical replication → an OPFS-SQLite client store with optimistic offline writes

- **Status:** **Accepted** (ratified 2026-06-30 after the two-lens review — red-team +
  chief-architect, grounded in the cited seams — see *Reviews*). The review endorsed the core
  decision (the clean topics-vs-data split, the shape as the unit of sync, the LSN cursor, and
  reuse of ADR 0040's long-lived-stream kind) and surfaced **decision-affecting findings — all
  bounded edits within the design, now folded into this draft**: the security-critical per-row
  authorization model gained three sharpenings (parameter-level authz, the `REPLICA IDENTITY FULL`
  old-image requirement that delete-from-shape silently depends on, and an explicit
  session-vs-membership revocation split); the resume cursor gained Postgres **system identity** (a
  failover/restore is the LSN-level twin of the cross-node false-continuity bug ADR 0040's round-2
  review caught); and the re-auth interval + client-side LSN persistence were specified. The build
  is gated on the adversarial multi-tenant **acceptance matrix** below.
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
  method here, the load-bearing moat claim (**as-built: a free function `live(table)`, not a chained
  `.live()` method — see the 2026-07-10 erratum**); the Postgres adapter and its pooled
  `BEGIN`/`COMMIT` transaction bracket (`packages/pg/src/adapter.ts:102,114`) — the logical-
  replication slot is a *new, dedicated* connection beside the pool, like ADR 0040's dedicated
  `LISTEN` client; the principal + authorization seam (`packages/authz/src/principal.ts:91`
  `getPrincipal`, `guard.ts:94` `can`) — a **shape** is authorized at subscribe time and the
  authz is re-checked, the same hole ADR 0040 closed for topics (`L-85655d2c`) (**as-built: an
  app-supplied `authorizeShape`/`resolvePrincipal` seam in `@lesto/live-server`, which carries no
  `@lesto/authz` dependency — see the 2026-07-10 erratum**); the client query
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
(**As-built: `live()` is the free function `live(table).where(col, "eq", value).query()`, not a chained
`.live()` method — the moat claim holds verbatim over it; see the 2026-07-10 erratum.**)
Local-first becomes **a property of the substrate, not a bolted-on service.** That is the thing no
app framework can coherently match, and the reason this is worth a hard, separate ADR.

(Precisely — a chief-architect honesty note from the review: `live()` lives on a **client-capable
surface of the builder that shares the server builder's query AST and types**; the server,
pool-bound builder has no browser runtime, so the moat is "one query language, one AST, one set of
types across both runtimes", not literally one object instance straddling client and server. The
strategic claim is undiminished: an app framework that merely *consumes* an external sync service
cannot offer `live()` as a first-class method on its own ORM.)

## Decision

### `live()` is a method on the ORM query — the shape is the unit of sync

A **shape** is a named, parameterized read query plus the principal it is evaluated for — e.g.
`messages WHERE room_id = :roomId`, for *this* user. It is produced by the existing query builder:

```ts
const messages = db.select().from(messagesTable).where(eq(messagesTable.roomId, roomId)).live();
//    ^ a LiveQuery<Message[]> — reads from the local store, stays in sync, writable offline
```

**⚠️ As-built (2026-07-10 erratum, see *Reviews*): the shipped surface is the free function
`live(table).where(col, "eq", value).orderBy(col, "asc").query()`, NOT a `.live()` method chained on
`db.select()...`.** A true `.live()` method is blocked on `@lesto/db` AST unification (its `eq()`
returns an opaque compiled `{sql, params}` Condition, not the serializable `{column, op, value}` a shape
needs) and a dependency-cycle inversion — filed as vNext. The moat claim is undiminished and holds
verbatim over the as-built surface: `live(table)` is a builder over the **same typed `Table`/`Column`
schema values** the app writes with — one query language, one AST, one row type across both runtimes
(`packages/live/src/builder.ts:1-17`). Read this heading and the sample above as that surface.

`live()` does not execute a one-shot `SELECT`; it **registers a shape** with the server's shape
engine and returns a reactive handle backed by the **local store**. The same SQL the builder would
have sent is the shape's definition — so the shape's `WHERE` is the *sync filter* (which rows stream),
and its **bound parameters** are *separately authorized* at subscribe time (the security-critical
distinction sharpened in review — see below). This is the moat claim made concrete: the developer
writes one ORM query and gets a synced, offline-capable, locally-queryable result, with no socket code
and no second query language.

### The wire carries auth-scoped **row data and diffs**, keyed by the commit **LSN**

Unlike ADR 0040's `(topic, cursor)`, the Tier 4 wire carries:

1. an **initial snapshot** — the rows matching the shape for this principal, at a known LSN; and
2. a **change stream** — inserts/updates/deletes to those rows, each stamped with the Postgres
   **commit LSN** as the authoritative, fleet-global, commit-ordered cursor.

The LSN is what ADR 0040 could *not* use: Postgres `LISTEN/NOTIFY` provides **no persistent global
resume sequence** — `NOTIFY` is delivered to *live* listeners in commit order (ADR 0040 relies on
exactly that), but a listener that was disconnected cannot ask for "every change after sequence N",
so ADR 0040 falls back to a node-local `(instanceId, generation, index)` cursor + resync-by-default.
**Logical replication exposes the commit LSN directly** as a persistent, replayable, commit-ordered
position, so Tier 4 gets a sound, fleet-global resume cursor: a client reconnecting presents its
last-applied LSN and the server replays the changes since it (or re-snapshots if the LSN has aged
past the slot's retention).

**The resume cursor is `(systemId, timelineId, LSN)`, not a bare LSN** (a red-team finding, sharpened
in review — the database-identity lesson, the LSN-level twin of ADR 0040's round-2 "the cursor needs
node identity" fix). An LSN is only meaningful within one WAL timeline on one cluster, and the two
identities are **distinct** — a review precision, do not conflate them: the **system identifier**
(`pg_control_system()`, fixed at initdb) is **constant** across a failover or restore and so catches a
pointer at a *different cluster*; the **WAL timeline id** **increments on every failover/promotion**
(and changes on PITR) and so catches a *same-cluster* failover that a constant `systemId` would miss.
After either event the WAL position space the LSN indexes has diverged, so a bare stored LSN would be
a **false continuity proof** — the client would "resume" against a different timeline and silently miss
or misapply changes. The cursor therefore carries **both**, and on reconnect replay is allowed only
when **`systemId` AND `timelineId` both match** the live database's; on any mismatch the client
**re-snapshots** rather than replays.

**The snapshot↔tail boundary must not gap.** A snapshot taken at LSN `X` and a live tail starting at
LSN `Y` must together deliver every change in `(X, Y]` exactly once: the tail backfills from the slot
from `X`, it does not start "now". This couples snapshot freshness to slot retention (see the
CDN-snapshot caveat under *Transport*): a snapshot cached longer than the slot's WAL retention is
**un-bridgeable** and forces a fresh snapshot — a real, designed-for tension between snapshot
cacheability and resumability, not a bug.

### The change source is Postgres **logical replication**, not `LISTEN/NOTIFY`

A **dedicated logical-replication connection** (a replication slot + `pgoutput`/`wal2json` decoding)
streams *every* committed change with its row image and LSN — beside the pool, never from it (a
replication connection is special and long-lived, the same discipline as ADR 0040's dedicated
`LISTEN` client, `adapter.ts`). `LISTEN/NOTIFY` is rejected here for the same reasons it was *right*
for ADR 0040 and *wrong* here: it carries no row data, no persistent resume sequence usable as a
cursor (it is commit-ordered to live listeners but not replayable for a reconnecting one), and an
8 KB payload cap. Logical replication is the substrate's real "what changed, with the data, in commit
order, replayably" feed — exactly what a sync engine needs.

### Per-row authorization — the hard problem ADR 0027 sidestepped, solved by **shape predicates**

Shipping rows means the server must decide, for **every changed row**, whether *this* principal may
see it. This is the per-row push-authz problem ADR 0027 avoided by shipping topics. Tier 4 confronts
it directly with a layered model:

- **The shape's `WHERE` is the *sync filter*; its bound parameters are *separately authorized*.** A
  principal subscribes to a parameterized shape — `messages WHERE room_id = :roomId`. The principal's
  own id/org/tenant is bound into the predicate **server-side, never client-supplied**, and the server
  only ever evaluates and streams rows that satisfy the predicate for that principal. **But the
  predicate filtering rows to `:roomId` is NOT by itself authorization** — `:roomId` is a client-chosen
  capability, so the subscribe-time check must authorize the *concrete bound parameters* (may this
  principal open `room_id = 999`?), not merely the shape *template* (may this principal use the
  `messages` shape?). A shape whose bound parameters resolve to another tenant's resource is refused at
  subscribe time via the existing authz seam (`can()` / a net-new shape-authz check over the *bound*
  shape, the Tier-4 analogue of ADR 0040's `L-85655d2c`). Conflating "the WHERE is the authz predicate"
  with "the WHERE *and its client-supplied arguments* are authorized" is the sharpest leak vector (a
  red-team finding); the acceptance matrix gates it explicitly.
- **A changed row is matched against every active shape's predicate before it is sent**, and only to
  the connections whose principal authorizes that shape. A row that moves *out* of a shape (an update
  that fails the predicate) is sent as a **delete-from-shape** (the client removes it), a row that
  moves *in* is an insert, and a row that stays is an update — so the client's local slice stays
  exactly the authorized set, with no leakage of rows the principal lost access to. **This requires the
  row's OLD image on UPDATE/DELETE, which Postgres emits only under `REPLICA IDENTITY FULL`** (a
  red-team finding): with the default replica identity the stream carries only the primary key of the
  old tuple, so a predicate over a *non-key* column (`room_id`, `owner_id`, `status` — i.e. almost
  every shape) cannot tell a row left the shape, and the row would silently **remain** in the client's
  store — a row the principal lost access to, now leaked and durably persisted in OPFS. Every table
  backing a shape whose predicate references non-PK columns therefore **must run `REPLICA IDENTITY
  FULL`** (a migration-time requirement and operational dependency, below); the shape engine validates
  this at shape-registration time and **refuses** a shape whose table cannot supply the old image its
  predicate needs, rather than silently leaking.
- **Re-authorization is continuous, not connect-time-only** (the ADR 0040 lesson), along **two
  distinct paths with different latencies, split by WHERE the authorizing value lives** (a sharpening
  from the review, corrected again by the Inc3 build): (1) *session validity AND the bound shape's
  authorization* are both re-resolved on a periodic interval — **default 60s, reusing ADR 0040's
  `DEFAULT_REAUTH_MS`** via the same `@lesto/realtime`-style machinery — and a failure of EITHER purges
  the client's durable slice (a `resync` frame) before severing the stream, bounded further by a
  connection TTL. This interval is what catches an *authorization-data* change in a relation **separate**
  from the streamed table (a user removed from a room via a `room_members`-style join) — the streamed
  row itself never changes, so nothing about it can appear on the replication feed; only re-invoking the
  bound-shape authz check observes the revocation. (2) An authorization-data change **on the streamed
  row's own columns** (a `room_id` a shape filters on, an `owner_id` reassigned) propagates
  **sub-interval, promptly**, as an ordinary delete-from-shape carried by the replication stream itself
  — no interval wait needed, because the row's own change *is* the signal. Conflating these two — as an
  earlier draft of this ADR did, promising "sub-interval" uniformly — overstated what a single-table
  replication classifier can observe; a cross-relation membership change is real but interval-bounded,
  and the interval is a security parameter more sensitive here than for ephemeral reactivity: until the
  next re-auth a revoked-but-still-connected session keeps receiving rows it then **durably persists**
  to OPFS, so the default is deliberately tight and the TTL bounds the worst case, and a severance
  purges rather than merely disconnects.
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
  requests durable storage so the browser does not evict it under pressure. *(As-built correction: the
  engine runs in a dedicated Worker, not the main thread — see the 2026-07-03 amendment.)*
- **The last-applied `(systemId, timelineId, LSN)` cursor persists *with* the rows, atomically** (specified in the
  review — the resume linchpin). Resume hinges on the client knowing exactly which changes it has
  already applied, so the cursor is a **single-row meta table inside the same OPFS-SQLite database**,
  updated in the **same transaction** as each applied change-batch — a crash then leaves a consistent
  `(rows, cursor)` pair, never rows-ahead-of-cursor (a missed change on resume) or cursor-ahead-of-rows
  (a silently dropped change). For the **in-memory** default the cursor is just a variable, lost on
  reload → a full re-snapshot on next open, which is correct (an in-memory store has no durable rows to
  resume). Only the **leader tab** (below) writes the store and the cursor; followers never persist one.
  The read-your-writes rule — "never accept a snapshot older than an LSN already applied" — reads this
  persisted cursor.

`live()`'s reactive handle re-runs its query against the local store whenever the store changes, so a
component re-renders from local data with no network round-trip. The existing `QueryClient`
(`data-client.ts:86`) sits **above** the store as the in-component cache; the store is the durable
tier beneath it.

### Optimistic **offline writes**, reconciled through the existing mutation path

A write while live is **applied to the local store immediately** (optimistic) and appended to a
**local mutation log**. When online, the log is drained by **replaying each entry as the app's normal
authorized `POST` mutation** — the same validation, authorization, and CSRF every online write passes
— *not* a bespoke sync-write server and *not* a direct client→queue channel (the precision the review
asked for: the server-side `@lesto/queue` is reached only *through* those authorized mutations, exactly
as an online request would; the client never enqueues a job itself). Each optimistic row carries a
**client-generated id** so the server's authoritative echo (via the replication stream) can be
**correlated** back to the optimistic row rather than landing as a duplicate insert — the reconciliation
linchpin a last-write-wins model needs. That echo then reconciles the local state: a confirmed write is
a no-op, a rejected write is rolled back locally, and a conflicting write resolves by **last-write-wins
by default**, with **Yjs/Loro per-field CRDTs as an opt-in later** (deliberately not v1 — most apps do
not need field-level merge, and CRDTs are a large surface). The reconciliation point is the ORM, the
moat again: the same models, the same authorized mutations, the same auth.

### Cross-tab: one leader syncs, the rest mirror

Multiple tabs of one origin must not each open a sync connection (the HTTP/1.1 6-connection cap, the
server fan-out cost). **Web Locks** elect a single **leader tab** that owns the sync connection and
writes the (shared, OPFS) store; **BroadcastChannel** fans store-change notifications to follower
tabs, which re-query the shared local store. Leader failover is automatic when the lock releases (the
leader tab closes). This mirrors ADR 0040's "one connection, many consumers" but moved entirely
client-side. **As built (`L-e970a392`), followers do not open the store — the single-owner OPFS VFS
forbids it — so the leader RELAYS its rendered slice over BroadcastChannel and followers mirror it
in memory; see the 2026-07-02 cross-tab amendment.**

### Transport: a CDN-cacheable snapshot + a live tail on the long-lived-stream kind

- The **initial snapshot** for a shape at an LSN is an idempotent, **CDN-cacheable** HTTP response
  (same shape + same LSN ⇒ same bytes ⇒ cacheable/`ETag`-able) — many clients opening the same public
  shape share one cached snapshot. **Caveat (pinned down in review):** byte-identical responses
  require a **deterministic row order** — a `SELECT` without `ORDER BY` may return rows in a different
  order across executions (planner/stats/vacuum), defeating the cache. A shape definition must therefore
  carry a total ordering (e.g. `ORDER BY` a unique key); the snapshot serializer enforces it. **And its
  LSN must stay bridgeable from the live slot** (see *the snapshot↔tail boundary*, above): a snapshot
  cached longer than the slot's WAL retention is un-bridgeable and forces a fresh snapshot, so
  cacheability is bounded by retention — a deliberate tension, surfaced in the review.
- The **live tail** is a long-lived stream that **reuses ADR 0040's runtime response kind**
  (`handleStream` / `isLongLivedStream`, `packages/runtime/src/server.ts`): no in-flight slot, no
  compression-buffering, bounded by the dedicated stream semaphore + per-IP cap. The Tier 4 endpoint
  is app-mounted exactly like `@lesto/realtime`'s SSE handler, reading the principal from context.
- **Read-your-writes / replica lag.** A client never accepts a snapshot older than an LSN it has
  already applied. An optimistic write is **held over the authorized set until its authoritative echo
  lands** — the shipped interim is a client-side sticky overlay (hold on ack, clear on the echo for the
  same key, with a bounded grace timer backstopping the never-echoed case; see the 2026-07-02
  sticky-overlay amendment, `L-436724ba`). The **LSN-exact hold** (keep the overlay until the stream
  confirms at a `>=` LSN) is the vNext refinement, **deferred** — it needs an exact commit-LSN source
  for a write and a keepalive-fed applied-LSN watermark the current engine does not expose.

### Phasing

- **v0 (dogfood, dev-loop parity):** **single table + simple equality/range filters**, with
  **SQLite-local polling/triggers standing in for logical replication** so the dev loop on SQLite
  matches the prod shape (the `docs/PERF-SECURITY-2026.md` v0 line). In-memory client store, online-
  only, last-write-wins. Proves `live()` end-to-end on the gallery. **Cursor parity is API-only, not
  semantic:** SQLite has no LSN, so v0 **resyncs on every reconnect** (no precise replay) — the `live()`
  *surface* is identical to prod, but the resume guarantee is the coarse floor until the v1
  logical-replication LSN lands. The dev/prod delta is stated, not hidden. **v0 also deliberately does
  NOT exercise the security-critical path** (a review honesty note): single-table simple filters,
  online-only, last-write-wins means no delete-from-shape-on-membership-change, no offline reconcile,
  and no `REPLICA IDENTITY` mechanic (SQLite has none). So a green v0 proves the `live()` *surface* and
  the dev loop — **not** the per-row authorization matrix, which is a v1 gate (below).
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
2. **`LISTEN/NOTIFY` as the change source.** No row data, no persistent global resume sequence usable
   as a cursor (commit-ordered to live listeners, but not replayable for a reconnecting one), 8 KB cap.
   Right for ADR 0040 (topics), wrong for Tier 4 (data + a replayable cursor). Logical replication is
   the substrate's real change feed.
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
  the ORM, auth-scoped, offline-capable, reconciled through the existing authorized mutations — the
  stated moat.
- A new server **shape engine** (logical-replication tap + per-shape/per-principal row authz) and a
  client **`@lesto/live`** store + sync client; the runtime long-lived-stream kind and the
  `@lesto/realtime` SSE machinery are **reused**, not rebuilt.
- The hardest new risk is **per-row authorization correctness** (a row leaking across a shape
  boundary, or a membership change not propagating as a delete-from-shape) — it must be the focus of
  the review and carry an adversarial, multi-tenant test matrix as an acceptance gate.
- **A second operational dependency on Postgres, with a production-outage footgun** (elevated by the
  review). A logical replication slot pins WAL until its consumer (the shape engine) acknowledges it,
  so a **stalled or dead shape-engine consumer accumulates WAL unboundedly and can fill the database
  disk — a hard outage**. The shape engine is the slot's single consumer and must consume continuously,
  bound its own lag, and on its own death **drop the slot** rather than let WAL pile up (a crash-only
  slot is a liability, not durability). Plus **`REPLICA IDENTITY FULL`** on every shape-backing table
  (above) — a migration-time requirement that also raises WAL volume (the full old row is logged on
  every UPDATE/DELETE). The deployment guide must cover slot-lag alerting, the disk-pressure runbook,
  and the replica-identity migration. SQLite remains dev/single-node via the v0 poll/trigger stand-in.
- Clear separation preserved: ADR 0027/0040 own *reactivity* (topics, no data); this ADR owns
  *local-first* (auth-scoped data). The `docs/brand/messaging.md` guardrail (`L-e819c686`) — claim
  "live queries" now, "local-first" only when this lands — is upheld.

## Acceptance criteria (the bar, when built)

- **Shape authz (the gate):** an adversarial multi-tenant matrix — (a) a principal opening a shape
  whose **bound parameters resolve to another tenant's resource** is refused at subscribe time (not just
  "another tenant's *template*" — the parameter is the capability), and this authorization is
  **continuous**: the bound shape is re-authorized on the re-auth interval for the connection's whole
  life, not merely once at subscribe; (b) a row that updates *out* of a
  principal's shape is delivered as **delete-from-shape and never silently retained**, proven
  specifically on a predicate over a **non-PK column** under **`REPLICA IDENTITY FULL`**, plus a test
  that the engine *refuses* a shape whose table cannot supply the old image it needs — **including a
  shape whose *key* is a UNIQUE non-PK column** (`slug`, `email`), not only a shape whose *filter* is
  non-PK (the 2026-07-02 amendment, `L-5c46b49b`): under `REPLICA IDENTITY DEFAULT` the old tuple is
  the *primary key* only, so a change to that unique key would strand the old row (no old key emitted)
  and an ordinary delete would carry only the PK (missing the client's key → the row survives), both
  silent OPFS leaks — so such a shape is refused at registration unless the table is `REPLICA IDENTITY
  FULL`; (c) a
  membership change (removed from a room) is caught by ONE of two mechanisms depending on where the
  authorizing value lives — an authorization column **on the streamed row itself** (`owner_id`
  reassigned, a `room_id` a shape filters on) propagates **sub-interval**, as an ordinary
  delete-from-shape carried by the replication stream (the row's own change *is* the signal); a
  membership relation **separate** from the streamed table (a `room_members`-style join) cannot be
  observed by that stream at all — the row being filtered on never itself changes — so it is instead
  caught at the next **re-auth interval tick** (≤ `reauthMs`), which purges the client's durable slice
  (a `resync` frame) before severing, never merely closing the socket and leaving already-delivered rows
  stranded on disk. (A true sub-interval *push*-revocation for the cross-relation case — a dedicated
  wire signal severing one subscription the instant membership changes, rather than waiting for the next
  tick — is deliberately deferred as a purely additive follow-up, not required for this gate.); (d) a
  revoked *session* is severed within the re-auth interval + TTL; (e) on reconnect where
  **either** the `systemId` **or** the `timelineId` differs from the live database's — including a
  *same-cluster failover* (timeline increments, `systemId` unchanged), the case a `systemId`-only check
  would miss — the client re-snapshots rather than replaying a false-continuity LSN. This branch now
  carries **two-part coverage**: a *forged-branch* cover — `examples/live-capstone/test/acceptance.pg.ts`
  assertion 6c hand-forges a `timelineId + 1` resume cursor and asserts the re-snapshot (deterministic,
  no standby) — and a *real-mechanic* proof — `examples/live-capstone/test/failover.pg.ts` (`L-45e1b56b`)
  stands up a real primary + physical streaming-replication standby and `pg_promote`s it so the WAL
  timeline increments for real (`systemId` held constant), asserting a reconnecting client with a
  pre-failover cursor re-snapshots — so the branch fires on the failover the real world produces, not
  only a forged cursor. The two halves sit at different maturities: the *forged-branch* cover runs in
  the **per-PR** acceptance gate (`ci.yml` `live-capstone-acceptance`), while the *real-mechanic* proof
  runs **out-of-band** — executed once locally (evidence under `examples/live-capstone/evidence/`) and
  in a `push`/dispatch job (`live-capstone-failover.yml`), NOT yet a per-PR gate (`L-34963d5f`). **This
  matrix is the gate.**
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

## Reviews

### 2026-06-30 — red-team + chief-architect, grounded in the cited seams → ratified

Both lenses verified the cited code (every file:line in *Touches* confirmed: `queries.ts:150`
`SelectBuilder`, `pg/adapter.ts:102/114` the `BEGIN`/`COMMIT` bracket, `authz/principal.ts:91`
`getPrincipal`, `authz/guard.ts:94` `can`, `ui/data-client.ts:86/210/244` the `QueryClient` +
`registerTopics`/`invalidateTopic`, `runtime/server.ts` `isLongLivedStream`/`handleStream`,
`realtime/http-handlers.ts` `DEFAULT_REAUTH_MS = 60_000`). The **core decision was endorsed**: the
clean topics-vs-data split (reactivity stays no-data per ADR 0027/0040; local-first gets its own data
wire), the shape as the unit of sync, logical-replication-with-LSN over `LISTEN/NOTIFY`, reuse of ADR
0040's long-lived-stream kind, and the scope discipline (single-table v1, no CRDT v1, no bespoke
write server, no Service-Worker background-sync). **Verdicts:** chief-architect **RATIFY-WITH-CHANGES**;
red-team **REVISE** (decision-affecting findings, all bounded edits within the design). This draft is
the revision — every finding below is **folded in**. The build is then gated on the acceptance matrix.

**Red-team — the per-row/per-shape authorization heart (decision-affecting, all folded):**

- **Parameter authorization, not just template authorization.** "The WHERE is the authorization
  predicate" conflated the *sync filter* with *authorization*. `messages WHERE room_id = :roomId`
  filters rows to `:roomId`, but `:roomId` is a **client-chosen capability** — so the subscribe-time
  check must authorize the *concrete bound parameter* (may this principal open `room_id = 999`,
  belonging to another tenant?), not merely "may this principal use the `messages` template". **Fixed**
  in the authz Decision + acceptance matrix (a) — the sharpest leak vector, now explicit.
- **`delete-from-shape` silently depends on `REPLICA IDENTITY FULL`.** Detecting that a row moved *out*
  of a shape needs the row's **OLD image**; under Postgres's default replica identity the stream carries
  only the old **primary key**, so a predicate over a non-PK column (`room_id`, `owner_id`, `status` —
  almost every shape) cannot tell the row left, and it **silently remains** in the client's OPFS store —
  a leaked, now-durable row. **Fixed**: `REPLICA IDENTITY FULL` is required on shape-backing tables, the
  shape engine refuses a shape whose table cannot supply the old image, and this is an explicit
  operational dependency + acceptance-matrix item (b). This is the single most important technical
  correction — the "membership change not propagating" risk grounded in the actual Postgres mechanic.
- **The resume cursor needs database identity — both cluster *and* timeline.** A bare LSN is a **false
  continuity proof** across a failover/restore — the LSN-level twin of the cross-node bug ADR 0040's
  round-2 review caught. **Fixed, then sharpened by a claims-accuracy lens** (the first draft's
  `(systemId, LSN)` was insufficient — `systemId` is *constant* across a same-cluster failover, so it
  alone would miss the commonest case): the cursor is `(systemId, timelineId, LSN)` — `systemId`
  (fixed at initdb) catches a *different cluster*, `timelineId` (increments on failover/PITR) catches a
  *same-cluster failover*; replay requires **both** to match, else re-snapshot (acceptance matrix (e)).
- **Session-revocation vs authorization-data-change are two paths with different latencies.** The
  re-auth interval (now specified: **60s default**, reusing `DEFAULT_REAUTH_MS`) catches *session*
  revocation coarsely; *membership* changes propagate **promptly** as delete-from-shape over the
  replication stream. The interval is *more* sensitive here than for reactivity because a revoked
  session's rows are **durably persisted** before the next re-auth. **Fixed** in the authz Decision.
- **Client-side LSN persistence (the resume linchpin) was unspecified.** **Fixed**: the `(systemId,
  timelineId, LSN)` cursor is a single-row meta table in the same OPFS-SQLite DB, written in the **same transaction**
  as each applied batch (no rows-ahead/cursor-ahead corruption); in-memory default loses it → re-snapshot;
  only the leader tab persists it.
- **Snapshot↔tail must not gap, and CDN-TTL is bounded by slot retention.** **Fixed**: the tail backfills
  `(X, Y]` from the slot; a snapshot cached past slot retention is un-bridgeable and forces a fresh
  snapshot — surfaced as a designed tension, not a bug.

**Chief-architect — coherence, build-ability, operational risk (folded):**

- **`live()` "on the same builder" is a client twin sharing the AST**, not one object instance
  straddling client/server (the server builder is pool-bound, no browser runtime). **Fixed** as an
  honesty note in the moat paragraph; the strategic claim is undiminished.
- **"Reconcile through the queue" was loose.** Offline writes replay as the app's **authorized `POST`
  mutations** (same validation/authz/CSRF); `@lesto/queue` is reached only *through* those, never a
  direct client→queue channel. Each optimistic row needs a **client-generated id** to correlate the
  replication echo (else a duplicate insert). **Fixed** in the offline-writes Decision.
- **Logical-replication slot = production-outage footgun.** A stalled/dead consumer pins WAL → fills the
  DB disk. **Elevated** in Consequences: the shape engine must bound its lag and drop its slot on death;
  the deployment guide owns slot-lag alerting + the disk-pressure runbook.
- **v0 does not exercise the security-critical path** (online-only, single-table, no `REPLICA IDENTITY`
  in SQLite). **Fixed**: a green v0 proves the `live()` surface + dev loop, **not** the authz matrix —
  stated in Phasing so v0 success is not mistaken for security evidence.

**Phrasing fix (folded):** `LISTEN/NOTIFY` "no ordering"/"no usable global sequence" → **"no persistent
global resume sequence"** (NOTIFY *is* commit-ordered to live listeners — ADR 0040 depends on that — it
just isn't replayable for a reconnecting one); the old wording contradicted ADR 0040.

**Deciders' sign-off:** the two-lens review is recorded and its decision-affecting findings folded;
final ratification rests with tech-lead + owner. No finding was design-blocking — each was a bounded
edit, now in the draft — so the ADR is marked Accepted with the **adversarial multi-tenant authz matrix
as the build-time acceptance gate** (its `REPLICA IDENTITY FULL` + parameter-authz + `systemId`-resume
items are the must-pass cases).

### 2026-07-02 — amendment: the old-image requirement covers the shape's KEY column, not just its filter columns (`L-5c46b49b`)

The `REPLICA IDENTITY FULL` analysis above (the red-team finding, acceptance (b)) reasoned about a
predicate over a **non-PK filter** column, but missed the symmetric case of the shape's **key** itself.
The shape engine identifies rows by any key that is **primary-key *or* unique**, so a shape may key on a
**UNIQUE non-PK** column (`slug`, `email`) — yet under `REPLICA IDENTITY DEFAULT` the replica-identity
key is the **primary key**, so the old tuple never carries the shape's key. Two silent, durable leaks
follow: (i) an update that changes the unique key but not the PK emits **no old key**, so the
key-change guard cannot fire and the old row is **stranded** under its old key (a stale duplicate the
client never removes); and (ii) an ordinary DELETE carries a `'K'` tuple = the PK only, **not** the
unique key the client store is keyed by, so the delete targets a key the client never held and the real
row **survives** — leaked into OPFS. The registration guard's old-image predicate was
`some(filter.column !== key)`, which is false for a filterless or key-only unique-non-PK shape, so it
was served and leaked. The fix threads the catalog fact `keyIsPrimaryKey`
(`table.byKey[def.key].primaryKey`) into the guard: a shape whose key is not the table's primary key
now needs the full old image just as a non-key filter does, and is **refused at registration** off a
non-FULL table with the same `LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT` error (a second message arm).
Under FULL the whole old row — including the unique key's old value — is emitted, so a key change is
caught loudly (`LIVE_SERVER_PRIMARY_KEY_CHANGED`) and a delete keys by the unique key correctly, never
stranded. Acceptance (b) is extended above. (A future `REPLICA IDENTITY USING INDEX` over the unique
index could carry the unique key AS the identity and relax this to that column alone — deliberately not
built; a follow-up.)

### 2026-07-02 — amendment: read-your-writes ships as a client-side sticky overlay; LSN-exact hold → vNext (`L-436724ba`)

The design bullet above framed read-your-writes as "held until the replication stream confirms it at a
`>=` LSN." Two independent adversarial reviews found that **LSN-exact confirm is not buildable on the
current engine** and rejected it: Postgres exposes no exact self-commit LSN to a SQL session
(`XactLastCommitEnd` is C-only; `pg_current_wal_insert_lsn()` post-commit is an upper bound), and the
mutation route boundary has no DB handle; the engine has no **global applied-LSN watermark** (the replay
ring's `latestLsn` is per-shape and advances only on in-shape changes, and `ChangeSource.onChange`
surfaces decoded row changes, not pgoutput `'k'` keepalives), so on a quiescent shape a `>=`-LSN confirm
never fires and the overlay is held open indefinitely — the exact leak the feature exists to close.

The **shipped interim** (`@lesto/live`, no protocol/server/mutation-contract change) is a **client-side
sticky overlay**: on ack the optimistic entry is marked `held` (kept shown, flagged durably on
`lesto_live_outbox`, dropped from the replay queue); it clears atomically when its authoritative echo — an
authorized `change`/`snapshot` for the same key — is applied (same store mutation, so no read-your-writes
flash), **or** when a bounded grace timer expires (the never-echoed backstop: a write filtered out of the
shape, or a resync/reconnect in the gap). A reject clears immediately; a reload rebuilds a held entry as
held **without** re-submitting it. Its worst case is exactly the pre-fix behavior (a late-cleared row),
never incorrectness — with one narrow, bounded exception: a held overlay masks a *concurrent third-party*
update to the same key for at most the grace window, which the LSN-exact hold would close.

The **LSN-exact hold is deferred to the vNext edge-DO bundle**, gated on prerequisites this interim does
not build: an exact commit-LSN source for a write, a keepalive-fed engine-global applied-LSN watermark
(extending `ChangeSource` to surface `'k'` keepalives), per-connection/per-principal confirm addressing,
and durable held-overlay persistence keyed by mutation id — the last of which this amendment already
lands (the `held` column), so the interim advances vNext rather than fighting it.

### 2026-07-02 — amendment: a classification error resyncs the shape; the `resync` frame is resume-breaking (`L-802b3e7b`)

The `REPLICA IDENTITY` guards above (acceptance (b), the `L-5c46b49b` key-column amendment) **refuse** an
unsafe shape at registration. But a shape can pass registration and *then* fail on a live change — a
classifier throw (a `FULL`→`DEFAULT` downgrade `LIVE_SERVER_OLD_IMAGE_INCOMPLETE`, a refused key change
`LIVE_SERVER_PRIMARY_KEY_CHANGED`, an unchanged external-TOAST predicate column), or — rejected at *ingest*,
before any classifier runs — a malformed commit LSN. The engine confined each such failure to `onError` and
moved on, but that is **not enough**: the change never reaches the shape's server-side `rows` or its replay
ring (a classifier throws before `applyChange`/`ring.record`; an ingest-rejected change is dropped for every
shape on its table), so the engine's OWN view is now missing it — the shape is diverged **server-side**, not
merely on the client, and it stays silently stale until the client happens to reconnect. This shares the
classification-error path with the same **purge + resync + sever** posture already mandated for a re-auth
failure (Decision: continuous re-authorization).

Two corrections, both load-bearing:

- **Drop the diverged shape, don't just frame it.** A `resync` frame alone would be theater: a racing (or
  subsequent) re-subscribe reuses the still-alive diverged entry and re-serves the leak from
  `[...rows.values()]`. So the engine now **removes the shape entry first** (rows + ring + classifier),
  then fans an `onResync` to every subscriber. A re-subscribe re-seeds from the DB (`fetchRows`) and
  re-runs the replica-identity guard against a fresh catalog probe — so a *persistent* misconfiguration
  (a real `FULL`→`DEFAULT`) converts "throw-and-diverge-forever" into the loud coded
  `LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT` (the refuse-don't-leak posture), while a *transient* failure
  (a key change, a TOAST omission) succeeds on re-subscribe and the DB snapshot converges by construction.
  A dropped **malformed-LSN** change applies the same drop to *every* shape on that table (each is missing
  it); `onError` is kept for both (these demand operator attention).

- **The `resync` frame is now resume-breaking.** `ShapeConnection.resync()` previously stamped its `id:`
  with the connection's last-delivered cursor. That is a **false continuity proof**: the frame says "your
  slice is gone" while its `id:` says "you are LSN-continuous", so the client's `EventSource` reconnects
  with `Last-Event-ID` = that real cursor and **replays missed changes onto the just-emptied slice** — a
  silent, durable, *strictly-worse* divergence. Every `resync` (re-auth purge, backpressure overflow,
  shape-drop) now carries a constant **non-resumable sentinel** (`v0:resync`, which `decodeResumeCursor`
  maps to `undefined` → the re-snapshot floor). `resync()` takes no cursor argument, so the hole cannot be
  reintroduced by construction. This also fixes a pre-existing latent bug on the **backpressure-overflow**
  path, which stamped a real cursor for the same replay-onto-dropped-slice reason.

Scope: the **v1** replication path only — the v0 poll self-heals every tick (it re-reads and diffs the
whole table), so its `runTick` catch is unchanged.

### 2026-07-02 — amendment: cross-tab as-built — the leader RELAYS its rendered slice; followers never open the store (`L-e970a392`)

Inc7 (`@lesto/live`'s `createCrossTabLiveQuery` + the reusable `electLeader` Web Locks primitive) implements
"one leader syncs, the rest mirror". Building it surfaced one correction to the Decision text above, which
said followers "**re-query the shared local store**". They cannot: the durable store is OPFS-SQLite over the
**SyncAccessHandle Pool VFS** (`packages/live/src/opfs-sqlite.ts`), which takes an *exclusive*, per-origin
handle — **only one tab can hold the store open at a time**. So the faithful realization of "the rest mirror"
is: the **leader owns the single durable copy** and **broadcasts its rendered `getRows()` slice** (the
authorized rows already merged with the optimistic overlay) over BroadcastChannel on every change; each
follower drives a plain **in-memory** store from those broadcasts. This *strengthens* the ADR's "followers
never persist" (only the leader writes OPFS) and gives followers the leader's exact read-your-writes view for
free — a follower mirrors optimistic edits with no extra plumbing, because they are already in the leader's
rendered rows. A late-joining follower gets the current slice via a one-shot `hello` handshake (it asks; the
leader re-broadcasts), so a tab opened during a quiet period is never left blank.

Two properties worth pinning down:

- **Failover RESUMES, it does not re-snapshot.** A promoted follower already holds the last-broadcast view;
  it seeds a fresh (empty) leader store with it so the swap shows no flash, then opens the one connection —
  which resumes from that view's cursor (`connectLiveData` seeds `?lastEventId=`, the Inc5 linchpin), so the
  server replays only what was missed. A durable leader store that hydrated its **own** persisted slice is
  left authoritative (not seeded over). This is the concrete payoff of persisting the cursor atomically with
  the rows: leadership handoff is cheap.
- **The relay is a whole-slice broadcast per change** — O(rows) structured-clone traffic between tabs. Fine
  for the bounded per-user shapes local-first targets; a **frame-diff relay** (broadcast the individual
  `change`, not the re-rendered slice) is the noted vNext refinement, deliberately out of Inc7.

Both browser primitives (Web Locks, BroadcastChannel) are reached through an injected
`CrossTabEnvironment` seam, so importing `@lesto/live` stays SSR-safe and the whole coordinator is
test-fakeable with an in-process lock queue + message bus. The result is the same `LiveQuery` handle
`createLiveQuery` returns, so `@lesto/live/react`'s `useLiveQuery(() => createCrossTabLiveQuery(def, opts),
deps)` binds it with no new hook. The end-to-end multi-tab acceptance (Inc8, `L-b1501de9`) exercises the
durable (SQLite) outbox under real failover. (As-built note per the 2026-07-03 errata below: the
automated acceptance exercises the store/outbox LOGIC over Node SQLite — the OPFS engine itself is
browser-only and is covered by the recorded evidence run + the filed `L-2e410682` smoke, not here.)

### 2026-07-03 — errata: the OPFS engine MUST run in a dedicated Worker (Inc9 P0, `L-565a4b33`)

The **first real-browser run** of the Inc8 capstone (`examples/live-capstone`, evidence task
`L-aa9779f5`) found the durable store DOA in every browser. As-built through Inc8,
`packages/live/src/opfs-sqlite.ts` booted `sqlite-wasm` + `installOpfsSAHPoolVfs` **on the main
thread**. SAHPool's precondition requires `FileSystemFileHandle.prototype.createSyncAccessHandle`,
which is `[Exposed=DedicatedWorker]` — **Worker-only in Chrome and Safari alike** — so the install
rejected with "Missing required OPFS APIs." Because `OpfsSqliteError` was caught nowhere, every tab
failed leadership and the app rendered no data. The bun/PG acceptance gate could not catch this: Node
has no OPFS, so its store legs run over `openSqlite` and never touch the OPFS engine. This is why the
epic was **reopened** and the closure rule tightened: *a deliverable whose runtime is browser-only
cannot close on a Node gate alone — it needs at least one recorded real-browser run.*

**Fix (Inc9):** the engine moves into a dedicated Worker (`packages/live/src/opfs-worker.ts`, loaded
via the `@lesto/live/opfs` subpath's `new Worker(new URL("./opfs-worker.ts", import.meta.url), { type:
"module" })`), where `createSyncAccessHandle` exists. The main thread drives it over a
request-id-correlated `postMessage` RPC (`opfs-rpc.ts`) shaped exactly like the pre-Inc9 sync
`exec`/`prepare` pair, wrapped by the **unchanged** `adaptSyncSqlite` — so the store/outbox/cursor
layers above the handle are untouched (the seam was already async). The RPC client is unit-tested
against a fake port pair; the two irreducibly-browser halves (the `new Worker` spawn and the
worker-side sqlite binding) stay coverage-excluded, backed today by ONE recorded manual browser run
(`examples/live-capstone/evidence/`) and a **FILED replacement gate not yet built**: the
headless-browser smoke `L-2e410682` will boot the real engine end-to-end in CI. Rejected: the
`sqlite3-worker1` promiser — it does not open SAHPool, and its fallback "opfs" VFS needs
SharedArrayBuffer → COOP/COEP, the header burden SAHPool was chosen to avoid. Two honest boundaries the
evidence records: a *fully-offline reload* still needs the app shell cached (no service worker ships in
the examples — a follow-up), and OPFS's Worker-only sync handle means the durable engine has **no
main-thread fallback** (so an OPFS-open failure should degrade loudly rather than wedge leadership —
the filed `S2` decision).

### 2026-07-04 — amendment: failover-resync — drop every shape on an identity change, revealed at every (re)connect so it engages before the first post-failover change (`L-f61264b0`, `L-2bd5c9f7`)

Acceptance (e) and the resume contract (`resume.ts`) already guard the **client**: a reconnect whose
stored `(systemId, timelineId)` differs from the live database's re-snapshots rather than replaying a
false-continuity LSN. But the **server-side** shape engine held pre-failover state that neither the
cursor guard nor `resumeFor` could see past, and that did not self-heal until the shape dropped — a
promoted standby (or a PITR-rewound timeline) left the engine's OWN view stale. Two passes closed it,
both load-bearing:

- **Drop every shape when a CHANGE reveals a new `(systemId, timelineId)` (`ac638bd`, `L-f61264b0`).**
  Inc1 stamps the live identity onto every change, so a change whose `(systemId, timelineId)` differs
  from the last-seen `liveIdentity` **is** the failover signal. Before this fix two windows stayed
  open past a promote: (i) **`resumeFor` stale-ring-replay** — the shape's replay ring still held
  OLD-timeline entries, so a pre-failover reconnect presenting an old-timeline cursor matched that
  ring and **replayed** it (both cursor and ring on the same dead timeline) instead of being forced to
  re-snapshot against the promoted DB; and (ii) **stale-snapshot-rows** — `entry.rows` still held
  pre-failover rows, including lost-on-promote writes the promoted node never received, so the next
  snapshot payload served them. The engine now **drops every shape the moment a change crosses the
  identity boundary, BEFORE applying that change**: each subscriber resyncs, and any re-subscribe
  re-seeds `entry.rows` from the promoted DB and mints a fresh ring on the new identity. This
  **subsumes** the prior `snapshotCursor` stale-identity guard (kept as belt-and-braces) — `resume.ts`
  collapses to `latestLsnFor(identity)`, which returns a shape's latest LSN only when its ring is on
  the live identity, else the `0/0` baseline, so a `v1:newId:newTl:<old-lsn>` mix can no longer be
  minted. The FIRST change (`liveIdentity` still `undefined`) is initialization, not a failover, so
  nothing drops.

- **Reveal identity at every (re)connect so the resync is not change-gated (`8c2b47e`, `L-2bd5c9f7`).**
  Pass 1 fires only when a change reaches `onSourceChange`, so between the `pg_promote`/PITR and the
  first post-failover change the same two windows stay open — **indefinitely on a quiet promoted DB**,
  and **forever on a stock `pg_promote` whose replication slot did not survive** (the tail error-loops;
  no change ever arrives). A new **`onIdentity` hook** on the `ChangeSource` contract fires the
  connection's `(systemId, timelineId)` at every (re)connect's `IDENTIFY_SYSTEM` — **before** the slot
  is (re)created or any change is wired — and the engine's identity-capture + failover-drop block is
  extracted into a single `revealIdentity()` driven from **both** the hook and `onSourceChange`. A
  promote now drops every shape the moment the new timeline is **known**, independent of change flow.
  The reveal is idempotent on a repeat of the same identity; a throwing handler is routed to the
  source's error sink (never breaks the awaited `#openAndStart`); and the terminal `stop()` clears the
  identity sink alongside the change sink, so a reconnect raced past stop fans to an empty set.

Scope: the **v1** logical-replication path only — the v0 SQLite poll has no `(systemId, timelineId)`
and resyncs on every reconnect already (Phasing), so it needs no failover signal.

### 2026-07-10 — erratum: three claims-integrity corrections ahead of the GA-claim review (the "next big feature" two-lens pass)

A pre-GA two-lens review (opus chief-architect + fable red-team) of the "publish + document + claim
`lesto.live`" wave found three places where this ADR's ratified text drifted from as-built reality.
None changes a decision; each is a bounded correction so a public claim never rests on a false line.

- **The `live()` surface is a free function, not a `.live()` method (folded inline at the Decision above).**
  As-built the shipped surface is `live(table).where(col, "eq", value).orderBy(col, "asc").query()`
  (`packages/live/src/builder.ts:130`), not the `db.select()...where(eq(...)).live()` method-chain the
  moat paragraph (`:80`), the Decision heading (`:93`), and its code sample (`:99`) advertise. **No code
  chains `.live()` anywhere in the tree** — so the method-chain form was aspirational, never shipped. A
  true `.live()` method is not a doc edit but engine R&D: `@lesto/db`'s `eq()` compiles column+op+value
  into an opaque `{sql, params}` Condition (`packages/db/src/conditions.ts:48`), from which the
  serializable `{column, op, value}` a `ShapeDefinition` requires cannot be recovered, and `@lesto/db`
  cannot import `@lesto/live` (a dependency cycle). Decision: **keep `live(table)`** (whose own docstring,
  `builder.ts:1-17`, already states the honest "one query language, one AST, one row type across both
  runtimes" reading); the true-method AST unification is **vNext**. The moat claim is undiminished.

- **The wired authorization seam is app-supplied, not `@lesto/authz`.** The *Touches* line (`:36-37`)
  cites `@lesto/authz`'s `getPrincipal` / `can()` as the shape-authz seam. As-built, `@lesto/live-server`
  carries **no `@lesto/authz` dependency**; a shape is authorized through an **app-supplied
  `authorizeShape` / `resolvePrincipal` seam** (`packages/live-server/src/http-handlers.ts`). The engine
  guarantees the seam is *always invoked* and cannot fail-open by omission — but it **cannot verify the
  app author authorizes the bound parameter** (`may this principal open room_id = 999?`) rather than the
  template. That makes the parameter-vs-template distinction (this ADR's sharpest leak vector,
  `:178-185`) an **app-author responsibility with no framework paved road today** — so a parameter-level
  authz helper is a **publish blocker**, not polish (tracked GA-3, `L-6a58325b`).

- **The headless-browser OPFS gate IS built (the 2026-07-03 errata's "not yet built" is stale).** The
  `L-2e410682` browser regression gate exists and runs (`.github/workflows/live-capstone-e2e.yml`) — it
  boots the real built bundle in real Chromium and asserts durable first paint + offline drain +
  cross-tab failover. The 2026-07-03 errata's "a **FILED replacement gate not yet built**" and
  `ci.yml`'s "proven by … the README's manual checklist" are both stale. The *remaining* work is
  narrower and tracked at GA-2 (`L-cc849577`): the gate lives in a standalone workflow **invisible to the
  release gate** (which only sees `ci.yml` jobs), and the real-**failover** proof
  (`live-capstone-failover.yml`) is still push/dispatch-only, not a per-PR gate (`L-34963d5f`). Browser
  breadth is also still Chromium-only — webkit/firefox are unrun (GA-4, `L-d88fd01c`).
