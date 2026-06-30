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

**The resume cursor is `(systemId, LSN)`, not a bare LSN** (a red-team finding — the database-identity
lesson, the LSN-level twin of ADR 0040's round-2 "the cursor needs node identity" fix). An LSN is
only meaningful within one WAL timeline; after a failover to a promoted replica or a restore from
backup the WAL position space changes, so a bare stored LSN would be a **false continuity proof** —
the client would "resume" against a different timeline and silently miss or misapply changes. The
cursor therefore carries the Postgres **system identifier / timeline**; on reconnect to a database
whose `systemId` differs from the cursor's, the client **re-snapshots** rather than replays.

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
  distinct paths with different latencies** (a sharpening from the review): (1) *session* validity
  (logout, token expiry, an admin revoking a session) is re-resolved on a periodic interval —
  **default 60s, reusing ADR 0040's `DEFAULT_REAUTH_MS`** via the same `@lesto/realtime` machinery —
  and the stream is severed on failure, bounded further by a connection TTL; (2) *authorization-data*
  changes (a user removed from a room, a row's `owner_id` reassigned) propagate **promptly,
  sub-interval**, as a delete-from-shape carried by the replication stream itself. The interval is a
  security parameter and is **more** sensitive here than for ephemeral reactivity: until the next
  re-auth a revoked session keeps receiving rows it then **durably persists** to OPFS, so the default
  is deliberately tight and the TTL bounds the worst case.
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
- **The last-applied `(systemId, LSN)` cursor persists *with* the rows, atomically** (specified in the
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
client-side.

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
  "another tenant's *template*" — the parameter is the capability); (b) a row that updates *out* of a
  principal's shape is delivered as **delete-from-shape and never silently retained**, proven
  specifically on a predicate over a **non-PK column** under **`REPLICA IDENTITY FULL`**, plus a test
  that the engine *refuses* a shape whose table cannot supply the old image its predicate needs; (c) a
  membership change (removed from a room) propagates as a removal sub-interval via the replication
  stream; (d) a revoked *session* is severed within the re-auth interval + TTL; (e) on reconnect to a
  database with a different `systemId` (failover/restore) the client re-snapshots rather than replaying
  a false-continuity LSN. **This matrix is the gate.**
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
- **The resume cursor needs database identity.** A bare LSN is a **false continuity proof** across a
  failover/restore (a new WAL timeline) — the LSN-level twin of the cross-node bug ADR 0040's round-2
  review caught. **Fixed**: the cursor is `(systemId, LSN)`; a differing `systemId` forces a re-snapshot
  (acceptance matrix (e)).
- **Session-revocation vs authorization-data-change are two paths with different latencies.** The
  re-auth interval (now specified: **60s default**, reusing `DEFAULT_REAUTH_MS`) catches *session*
  revocation coarsely; *membership* changes propagate **promptly** as delete-from-shape over the
  replication stream. The interval is *more* sensitive here than for reactivity because a revoked
  session's rows are **durably persisted** before the next re-auth. **Fixed** in the authz Decision.
- **Client-side LSN persistence (the resume linchpin) was unspecified.** **Fixed**: the `(systemId,
  LSN)` cursor is a single-row meta table in the same OPFS-SQLite DB, written in the **same transaction**
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
