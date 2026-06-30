# ADR 0040 — Realtime transport: a tiered topic bus (in-process → Postgres `LISTEN/NOTIFY` → edge DO) with an **SSE** browser fan-out

- **Status:** **Accepted (ratified 2026-06-30 after two review rounds — see *Reviews*).**
  This is the **transport leg ADR 0027 referenced but never wrote** ("Durable Objects are
  the fan-out point, owned by the transport/realtime ADRs" — those ADRs did not exist). It
  owns cross-process delivery and browser fan-out for ADR 0027 Phase 2 ("live `useQuery`")
  and nothing above the wire: it carries **invalidation topics, never row data**. Round 1
  corrected two decision-affecting errors — an unsound `seq` ordering claim and the false
  "no new server primitive" claim — and split the transport out of the dependency-free
  `@lesto/pubsub` package into a new app-wired `@lesto/realtime` layer. Round 2 closed the
  last two: the resume cursor now carries an **`instanceId`** (a node-local `(generation,
  index)` cursor silently mis-replayed across a non-sticky load balancer), and the
  long-lived-stream exemption is now backed by a **dedicated global stream semaphore +
  IP-keyed anonymous bucket** (the in-flight-gate exemption otherwise removed the only
  global stream backstop).
- **Date:** 2026-06-27 (drafted) · 2026-06-30 (ratified).
- **Deciders:** tech lead + owner.
- **Builds on / touches:** ADR 0027 (reactive data — this is its transport; the spine
  *"the writer declares a dirty topic; the push carries no data; the subscriber refetches
  through the authorized read"* is law here); ADR 0006 (async data layer); ADR 0013
  (durable stores); ADR 0016 (secure-by-default kernel); ADR 0028 (operator control plane —
  `getPrincipal` / roles); ADR 0032 (dev-loop — the existing **dev** live-reload WS; cited
  only for the Origin idea, not its threat model — see *Security*). Concrete seams:
  `@lesto/pubsub` the in-process hub (`packages/pubsub/src/pubsub.ts:33,72`, dependency-free,
  zero consumers); `LestoBody = string | Uint8Array | ReadableStream` + the stream pipe
  (`packages/web/src/types.ts:64`, `packages/runtime/src/response.ts:544`) and its
  **compression transform** (`response.ts:546`); the in-flight gate + handler-timeout +
  abort signal that long-lived streams collide with (`packages/runtime/src/server.ts:387,406,1283,1342,1471`);
  the app-mounted-handlers precedent `createMcpHttpHandlers` (`packages/mcp/src/streamable-http.ts:200`)
  and the existing **production** `/__lesto/*` receivers (`packages/runtime/src/browser-spans.ts:40`,
  `client-errors.ts:36`); per-request context + its `signal` (`packages/web/src/context.ts:113`);
  principal + authorization `getPrincipal`/`can` (`packages/authz/src/principal.ts:91`,
  `guard.ts:94`); the edge dispatch `toFetchHandler` (`packages/cloudflare/src/fetch-handler.ts:769`,
  `:385`); the pg adapter (`packages/pg/src/adapter.ts:97`); the client topic→keys registry
  `QueryClient` (`packages/ui/src/data-client.ts:158`). New package: **`@lesto/realtime`**.
  Board: this ADR is `L-d157d63f`; it **blocks** `L-ee9433f8` (PG transport) and
  `L-dd3cdca1` (browser fan-out), which with `L-585595de` (Phase 1) unblock `L-57dab2a1`
  (Phase 2). `L-dbd589ef` (missed-message) and `L-85655d2c` (subscription authz) are
  designed here; `L-c5beede7` is **re-scoped** from a DB hook to a caller-ordering
  convention (see *Phase A*).

## Context

ADR 0027 decided *what* reactivity is (explicit-topic invalidation) and deferred *how the
topic crosses a process and reaches a browser* to "the transport/realtime ADRs" — which
were never written. This ADR closes that gap, on the substrate as it actually is
(audited 2026-06-27):

- **`@lesto/pubsub` is an in-process, dependency-free hub with zero consumers**
  (`pubsub.ts:33,72`). Its surface is free to build on, but it must **stay** dependency-free
  (it may be edge-bundled) — so transports go *beside* it, not *inside* it.
- **The response body is already a stream** (`types.ts:64`, piped at `response.ts:544`) — but
  "an SSE endpoint is just a normal response" is **false**, three ways the reviews proved:
  1. **A streaming response holds a request-concurrency slot for its whole life.**
     `handleAdmitted` awaits `applyResponse` → `pipeStream` resolves only on stream
     finish/error (`server.ts:1471`, `response.ts:548`); the slot is released in `finally`.
     The default cap is 1,000 in-flight (`server.ts:406`). At ~1,000 idle live users the node
     sheds *all* traffic with 503 while doing no work — a self-DoS.
  2. **Compression is on by default and buffers SSE.** `compress` defaults on
     (`server.ts:940`); `text/event-stream` matches the `text/` compressible prefix
     (`response.ts:349`); the inserted zlib transform (`response.ts:546`) buffers without a
     per-frame flush, so frames never reach `EventSource`. SSE is broken out of the box.
  3. **`context.signal` is also the 30s handler-timeout guillotine.** The signal used for
     disconnect teardown is the same one `handlerTimeoutMs` (30s default, `server.ts:387`,
     wired at `:1342`) aborts. A naive SSE handler is killed at 30s.
  The runtime therefore **needs real streaming-aware changes** before SSE is viable
  (specified under *Decision → runtime*). The earlier draft's claim that
  `requestTimeoutMs`/`headersTimeoutMs` would kill the connection was wrong — those are
  slowloris guards on request *receipt*; the real timer is `handlerTimeoutMs`.
- **We already mount production app handlers** that read the principal from context
  (`createMcpHttpHandlers`, `streamable-http.ts:200`; the `/__lesto/*` receivers). The
  fan-out endpoint follows this pattern and is **app-wired**, preserving the codebase's
  no-`kernel→transport` edge.
- **Principal + authorization exist but not the *right* check.** `getPrincipal`
  (`principal.ts:91`) is resolved once at request entry; `can()` (`guard.ts:94`) is
  role→permission. **Topic authz is principal→tenant-scope** (does the principal's org own
  `org:123`?) — a *different*, net-new check (`L-85655d2c`), and it must not be a connect-time
  one-shot (a stream lives for hours).
- **The edge has neither Durable Objects nor WebSocket** (`packages/cloudflare` is a stateless
  fetch handler; `toBodyInit` does pass `ReadableStream`, `:385`). The edge fan-out is
  genuinely greenfield and **phased last**.

Two forces shape the design. (1) The payload is **server→client, one-directional, text, and
tiny** — a topic plus a cursor; mutations are ordinary authorized `POST`s. (2) ADR 0027 left
the hardest correctness problem — *a client that misses a topic while briefly disconnected is
silently stale forever* — hand-waved into Phase 3. The reconnect-and-resync protocol is a
**transport** concern and is designed in here (`L-dbd589ef`).

## Decision

### Packaging: keep `@lesto/pubsub` pure; compose transports in a new `@lesto/realtime`

- **`@lesto/pubsub` stays the dependency-free in-process hub** — the **universal delivery
  point for the node tier** (on the edge, Phase C, the Durable Object plays that role). Every
  transport's only job is to land a remote `publish` *into the local hub*; in-process consumers
  (the SSE endpoint, fleet cache invalidation) subscribe to the hub and never know which
  transport fed it. Honest contract note: `publish`'s return count is
  **local-only**; cross-process publish is **fire-and-forget into the bus** (you cannot await
  remote delivery, and a dropped topic is recoverable by resync — see below).
- **`@lesto/realtime` (new, app-wired) composes everything.** It defines a small **transport
  interface** (`publishRemote(topic)` + `onRemoteMessage(cb)` + connect/close lifecycle) — the
  seam is this interface, *not* the `PubSub` class. It hosts the Postgres transport (depends on
  the pg driver, where `pg` already lives), the bounded replay ring, and
  `createRealtimeHttpHandlers` (the SSE endpoint; depends on `@lesto/web` context +
  `@lesto/authz`, exactly like `@lesto/mcp`). It is mounted by the app/bin, not the kernel —
  preserving the no-`kernel→transport` direction. The edge DO transport lives in
  `@lesto/cloudflare`.

### The wire carries `(topic, cursor)` — never data, never a row

Every frame is a **topic** (the ADR 0027 invalidation string, e.g. `org:123:posts`) and a
**resume cursor**. No payload, ever — the invariant inherited from ADR 0027 that lets the
channel need no per-row authz. The cursor is the spine of missed-message recovery and is
defined below to be sound under real Postgres delivery semantics.

### The browser wire is **Server-Sent Events**, not WebSocket

SSE is the deliberate default: it matches the server→client, one-way, text payload exactly
(we never need the client→server half — mutations are `POST`s); `EventSource` ships
reconnect-with-backoff *and* a resume cursor (`Last-Event-ID`) for free; it rides the existing
`ReadableStream` response path; and it degrades to a streamed `Response` on the edge. The one
real cost — the HTTP/1.1 **6-connections-per-origin** cap (shared across *all* tabs of an
origin, not per tab) — is a genuine multi-tab hazard on HTTP/1.1 and **dissolves under HTTP/2**
(Tier 3); stated, accepted, and a reason to prioritize HTTP/2 for realtime deployments.
WebSocket is reserved for a genuine bidirectional need (collaborative editing, Tier 4 CRDTs)
and is **out of scope** here.

### Runtime: long-lived streams become a first-class response kind

This is the retraction of "no new server primitive." A long-lived response is recognized by a
**route predicate** on the reserved `GET /__lesto/live` path — **not** a flag on the response
object: the in-flight slot is released *unconditionally* in the dispatch `finally`
(`server.ts:1295`), so flipping a flag mid-response to skip that release would double-free the
semaphore. The predicate (mirroring the existing `isHealthProbe` bypass, `server.ts:1272`)
decides **before** admission. For such a route the runtime:

- **does not take an in-flight slot** (no slot held for the connection's life) — *but* admits it
  under a **separate, dedicated max-concurrent-streams semaphore**, so the exemption does not just
  remove the only global backstop and open an unbounded-stream DoS. Over-ceiling connections are
  refused with a coded error (see *Security* for the per-principal + anonymous-bucket layers).
- **never compresses it** — `text/event-stream` is removed from compression negotiation in
  `isCompressibleType` (`response.ts:340`); frames are tiny and a buffering zlib transform
  (no `Z_SYNC_FLUSH`) would stall delivery entirely.
- **logs at first byte** with an **active-stream gauge**, not at teardown — today the access line
  sits in the post-`applyResponse` `finally`, so a stream is invisible in the log until it closes.
- **is defense-in-depth on the timeout, not load-bearing:** `handlerTimeoutMs` (`withTimeout`,
  `server.ts:1423`) wraps only response *production* and is cleared the instant the handler returns
  its `ReadableStream` (`:569`), so it never bites a well-behaved stream. The long-lived kind is
  nonetheless marked exempt, and teardown keys **strictly off the disconnect reason**
  (`RUNTIME_CLIENT_DISCONNECTED`) vs a timeout (`RUNTIME_HANDLER_TIMEOUT`). The handler **must
  return its `ReadableStream` promptly** and use `context.signal` solely for teardown.

### Phase A — Postgres `LISTEN/NOTIFY` transport (`L-ee9433f8`)

- **One dedicated long-lived listening `pg.Client`** per process — *not* from the `@lesto/db`
  pool (`LISTEN` pins a connection; a pooled client would starve/poison normal queries) — with
  its own reconnect-and-`re-LISTEN` loop. Each re-LISTEN starts a **new listen generation**
  (an epoch counter), because a gap in `LISTEN` means missed `NOTIFY`s (Postgres does not
  buffer them) — generations make that gap *detectable* (see *missed-message*).
- **One channel, topic in the payload:** `NOTIFY lesto_invalidate, '<topic>'`. All processes
  `LISTEN lesto_invalidate` and re-publish the decoded topic into their local hub, where
  per-topic and per-connection filtering happens. One channel avoids a per-topic `LISTEN`-storm
  and keeps authz in the app where the principal lives. The 8 KB cap is a non-issue (a short
  string). *(At very high mutation rates the single channel + single listening client per process
  is a fan-in bottleneck; acceptable for the target scale and shardable across N channels later
  if measured — not solved here.)*
- **Ordering authority — the commit-ordered delivery stream, not a `SEQUENCE`.** Postgres
  delivers `NOTIFY` to every listener **in commit order, identically**. The earlier draft's
  `SEQUENCE`/`txid` was unsound (monotonic by `nextval()` *call* order, not commit order — a
  later-numbered txn can commit first, and `Last-Event-ID` resume would then permanently skip
  the earlier write). We therefore **never rely on a fleet-global numeric `seq` for
  correctness.** The cursor is **`(instanceId, generation, index)`** — `instanceId` a per-process
  id minted at boot, `generation` the listen-epoch (bumped on every re-LISTEN), `index` the
  position in that node's contiguous receive stream. **The `instanceId` is load-bearing:**
  without it, two nodes reuse the same `(generation, index)` space, so a client reconnecting to a
  *different* node (the common case behind a non-sticky load balancer) would present a cursor the
  new node mistakes for its own position and "replay" the wrong frames → silent staleness. Precise
  replay is permitted **only when `cursor.instanceId` equals this process's `instanceId`** (and
  the cursor is within the current generation's ring); any other cursor — different node, prior
  generation, or older than the ring — forces a coarse resync (below). The DB never mints an id.
- **Publish-on-commit is caller-ordering, not a DB hook (`L-c5beede7` re-scoped).** For the
  Postgres path, `NOTIFY` issued inside the writing transaction fires at commit *for free*.
  For the in-process/SQLite path, `db.transaction(fn)` **already resolves only after `COMMIT`**
  (`adapter.ts:114`), and single-statement auto-commit writes don't go through `transaction()`
  at all — so the correct, sufficient rule is **publish after the write's `await` resolves**
  (`await db…; await publish(topic)`), which also matches ADR 0027's "the writer declares what
  it dirties." A generic post-commit hook on the DB adapter is **cut** — over-reach for zero
  benefit (no transactional outbox is needed). **But the load-bearing direction is one-way:**
  *under*-delivery (a lost topic) is resync-recoverable, whereas publishing *before* commit is
  **not** — a subscriber would refetch pre-write state, spend the invalidation, and never
  reconnect → silently stale. So "publish strictly after the write's `await` resolves" is a
  convention the re-scoped `L-c5beede7` **enforces with a lint + test guard**, not merely documents.
- **Read-your-writes (replica lag).** The model is invalidate→refetch-through-the-authorized
  read; that refetch **must observe the committed write**. On a single-primary deployment this
  is automatic. With read replicas it is **not** — a refetch hitting a lagging replica
  re-caches pre-write state and spends the invalidation. The requirement: **post-invalidation
  refetches read the primary** (or carry the commit LSN and wait for replica catch-up). Stated
  as a deployment constraint; default config reads primary.
- **SQLite / single-process** keeps the in-process hub (dev, single-node prod); cursor is a
  single-generation local counter. **Cross-process realtime on one SQLite file is not solved**
  (no `NOTIFY`) — a documented constraint; Postgres is the fleet bus.

Phase A is independently useful before any browser work (fleet cache invalidation rides the
bus) — noted as a *consequence*, not pulled into this ADR's build scope.

### Phase B — the SSE browser fan-out (`L-dd3cdca1`)

`createRealtimeHttpHandlers(...)` returns a `Handler` mounted at **`GET /__lesto/live`**. Per
connection:

1. **Resolve the principal** (`getPrincipal(c)`).
2. **Read requested topics** (query string) and the resume cursor (`Last-Event-ID` /
   `?lastEventId=`).
3. **Authorize every topic against the principal (`L-85655d2c`, net-new seam)** — principal→
   tenant-scope, not the role→permission `can()`. Unauthorized topics are dropped+logged, not
   fatal. This closes ADR 0027's change-*timing* side-channel.
4. **Re-authorize on an interval and bound connection lifetime.** Connect-time-only authz is a
   hole: a stream lives for hours, and after session expiry / logout / revocation / role
   downgrade it would keep leaking change-timing. The connection carries a **max TTL** (the client
   transparently reconnects, re-authorizing) and a periodic re-auth that **re-resolves session
   validity** — it re-runs the principal resolver / checks revocation, *not* re-reads the
   entry-time principal the runtime resolves once; a revoked or expired session has its stream
   severed. (A meatier seam than connect-time authz — part of `L-85655d2c`.)
5. **Open the long-lived `ReadableStream`** (`text/event-stream`, `Cache-Control: no-cache`,
   `no-transform`, `X-Accel-Buffering: no`), subscribe authorized topics to the local hub, and
   for each delivery enqueue `event: invalidate\ndata: <topic>\nid: <cursor>\n\n`.
6. **Per-connection bounded outbound queue (backpressure) — and the non-blocking-listener
   invariant.** The hub delivers serially with `await` (`pubsub.ts:81`) *and* that delivery is
   itself awaited by the LISTEN/NOTIFY re-publisher — so the SSE hub listener **must
   enqueue-and-return synchronously and never `await` the socket write**; otherwise one slow
   client head-of-line-blocks every subscriber on the topic *and* back-pressures the node's whole
   invalidation stream (the exact self-DoS this design exists to kill). Each connection gets a
   **bounded queue** drained to the socket asynchronously; on overflow that *one* connection is
   dropped to a `resync`, never stalling others. **Invariant: the hub callback returns
   synchronously.**
7. **Heartbeat** a `: ping` comment on an interval **< the tightest intermediary idle timeout**
   (notably Cloudflare's ~100s) to hold the stream open and detect dead peers.
8. **Tear down** on `context.signal` disconnect (reason `RUNTIME_CLIENT_DISCONNECTED`):
   unsubscribe, clear timers, close.

**Client consumer lives in `@lesto/ui`, opt-in and tree-shakeable.** The topic→keys registry
is already the `QueryClient` (ADR 0027 Phase 1, now shipped — `registerTopics` /
`invalidateTopic` in `data-client.ts`); the `EventSource` consumer that maps a frame →
`QueryClient.invalidateTopic(topic)` (the wire carries a *topic*, not a key) belongs next to it as an opt-in
`connectLive()`/hook — **not** in `@lesto/client` (wrong concern) and **not** a new package.
`@lesto/ui` is the preact-aliased, bundle-gated package (the recent `sideEffects:false`
battle), so the consumer **must be tree-shakeable** and never enter the default island bundle.

**Thundering herd.** A hot topic with N subscribers = N refetches per mutation. The client
consumer **coalesces** topic invalidations within a short window and dedupes keys before
refetching; the refetch itself rides the existing HTTP cache / SWR (Tier 2) and `cache.remember`
single-flight. Inherent to invalidate-and-refetch, bounded to a topic's subscribers, and
mitigated — not eliminated; stated honestly.

Phase B + Phase A + ADR 0027 Phase 1 = **live `useQuery`** with no socket code in app code —
Convex / Supabase-Realtime parity on plain Postgres.

### Missed-message recovery — resync-by-default, precise replay when provably continuous (`L-dbd589ef`)

Correctness rests on a floor, not on cursor arithmetic:

- **The floor: every reconnect reconciles.** On reconnect the endpoint emits a single
  `event: resync` and the client refetches all topics it subscribes to — *unless* it can
  **prove continuity**. Always correct; over-refetching is harmless (idempotent).
- **The optimization: a bounded per-process replay ring** of recently delivered topics, keyed
  by `(instanceId, generation, index)`. Fast-path replay (just the missed topics) is used
  **only when** the client's cursor carries **this process's `instanceId`** and **current
  generation**, and its `index` is within the ring — i.e. the client reconnected to the **same
  node**, that node never lost its `LISTEN` in the window, and the window fits the ring (a
  same-node / sticky-session win). **Any** other case — a different node (no `instanceId` match),
  a prior generation, or a cursor older than the ring — falls back to `resync`. So the ring is a
  latency optimization whose hit-rate tracks session stickiness; **correctness never depends on
  it**, and cross-node reconnects always resync.
- **Ring bounds are explicit:** a fixed max entry count *and* a max age; whichever is hit first
  caps memory and defines the fast-path window.

The headline guarantee, now true: **a disconnect can never leave the UI silently stale — a
reconnect reconciles by precise replay when provably continuous, else by a coarse resync.**

### Phase C — edge fan-out via a Durable Object (deferred, designed)

A Worker isolate cannot hold a connection. The held SSE (or future WS) stream is owned by a
**Durable Object** — the single addressable point that holds the live streams for its key range
and receives `publish`es from mutation-path Workers via DO `fetch`/RPC, then fans out. Cursor
authority on the edge is the DO. Greenfield (no DO in `packages/cloudflare` today), larger than
A+B, **explicitly last** — the node fleet ships the live moment first.

### Security posture

- **Same-origin via SameSite cookies + no CORS** is the real control — **not** an Origin
  header check. `EventSource` is a GET that often sends **no `Origin`**, and the production
  runtime has no inbound Origin gate; a cross-site `EventSource` under `SameSite=Lax/Strict`
  carries no session cookie → resolves anonymous → public topics only. (The ADR 0032 dev-WS
  Origin check is a *different threat model* — loopback, dev-only, per-session token — and does
  not transfer; cited only for the idea. The honest production precedents are the existing
  `/__lesto/*` receivers.)
- **Subscription authz is the access decision** (step 3), re-checked on an interval (step 4).
- **GET → CSRF does not apply** (ADR 0027); the session cookie authenticates, the per-topic
  authz gate authorizes.
- **Resource bounds enforced, not hand-waved:** a **global max-concurrent-streams semaphore** —
  the dedicated backstop that replaces the in-flight gate the long-lived kind is exempt from —
  *plus* a **per-principal connection cap** and a max-topics-per-connection. The **anonymous
  bucket is keyed on client IP** (not the single shared anonymous principal — else one cap
  throttles every anonymous live user, or an attacker rotates principals to evade it), with its
  own lower ceiling. Over-cap → a coded refusal.

## Non-goals

- No client→server traffic on this channel (mutations are authorized `POST`s).
- **No row data on the wire — ever.** Only `(topic, cursor)`. The Tier 4 *local-first* sync
  engine — which *does* stream auth-scoped data shapes to an OPFS-SQLite store — is a
  **different wire and a different ADR**, not this one.
- No WebSocket in v1 (SSE is the browser wire; WS reserved for Tier 4 bidirectional).
- No general message bus / RPC / fan-in (`@lesto/queue` owns work).
- No cross-process realtime on SQLite (documented constraint).
- No transactional outbox / DB post-commit hook (caller-ordering + resync suffice).

## Rejected alternatives

1. **WebSocket as the default browser wire** — buys an unused client→server half, a new socket
   primitive (forfeiting the `ReadableStream` path), and a hand-rolled reconnect+resume that
   `EventSource` gives free. Reserved for genuine bidirectional needs.
2. **A fleet-global numeric `seq` (Postgres `SEQUENCE`/`txid`) as the resume cursor** — unsound:
   monotonic by call order, not commit order, so `Last-Event-ID` resume can permanently skip an
   earlier-numbered, later-committed write. Replaced by an **`(instanceId, generation, index)`**
   cursor with resync-by-default — the `instanceId` is what stops a cross-node reconnect from
   matching another node's `(generation, index)` positions and mis-replaying (round-2 fix).
3. **One Postgres channel per app topic** — dynamic `LISTEN/UNLISTEN` churn and a `LISTEN`-storm,
   and it pushes authz into the DB. One channel + in-process filtering keeps authz in the app.
4. **`LISTEN` on a pooled connection** — `LISTEN` pins a connection for the process lifetime;
   from the pool it starves/poisons normal queries. A dedicated client is mandatory.
5. **A post-commit hook on the `@lesto/db` transaction seam** — over-reach: the transaction
   already resolves after `COMMIT`, single-statement writes bypass it, and a dropped topic is
   resync-recoverable. Caller-ordering is sufficient and simpler.
6. **Transports inside `@lesto/pubsub`** — would regress a dependency-free, edge-bundleable util
   into a heavy `pg`/DO-dependent package. Transports live in their dep-owning packages, composed
   by `@lesto/realtime`.
7. **Pushing the row/diff on the wire (Electric/Zero)** — reintroduces per-row push authz,
   contradicts ADR 0027's no-data invariant, strictly bigger. The right model for local-first;
   owned by the Tier 4 ADR, deliberately separate.
8. **Deferring missed-message recovery to ADR 0027 Phase 3** — the resume cursor is a transport
   concern and the `id:` field must exist from the first frame; "silently stale after a 2-second
   disconnect" is a trust-breaking default. Designed in here.

## Consequences

- ADR 0027 Phase 2's dangling dependency is resolved with a concrete transport, a concrete
  browser fan-out, a sound resume protocol, and a named owner.
- The runtime gains a real **long-lived-stream response kind** (route-predicated: no in-flight slot
  but a dedicated global stream semaphore, no compression, first-byte logging) — reusable by any
  future streaming surface, not just SSE.
- The live moment ships on a **node fleet first** (Postgres `LISTEN/NOTIFY` + SSE); the edge DO
  fan-out is an honest, separately-scoped follow-up.
- Reactivity reaches Convex/Supabase-Realtime parity on **plain Postgres**, without violating the
  no-data-on-the-wire discipline, and with disconnect-staleness impossible by construction.
- `@lesto/pubsub` stays pure; a new `@lesto/realtime` owns transport + fan-out; the client
  consumer is an opt-in, tree-shakeable addition to `@lesto/ui`; `@lesto/cache` fleet invalidation
  is a free rider on Phase A.
- Board adjustment: `L-c5beede7` re-scoped (DB hook → caller-ordering convention + docs); a
  `@lesto/realtime` package-creation task and a runtime long-lived-stream task should be added
  under the reactivity epic.

## Acceptance criteria (build-time, the bar)

- **Runtime (prereq):** a long-lived streaming response does **not** consume an in-flight slot
  (a test: N+1 concurrent streams past the in-flight cap still admit normal requests) but **is**
  bounded by the dedicated global stream semaphore (over-ceiling streams refused with a coded
  error; an IP-keyed anonymous-bucket test proves anonymous floods don't exhaust the global pool);
  `text/event-stream` is never compressed even under `Accept-Encoding: gzip, br`; the in-flight
  exemption is via the **route predicate** (no flag-driven double-release of the semaphore); the
  access log emits at first byte with an active-stream gauge; an SSE handler survives past
  `handlerTimeoutMs` and tears down only on `RUNTIME_CLIENT_DISCONNECTED`.
- **Phase A:** a two-process integration test (one Postgres) — `publish` in process 1 reaches a
  hub subscriber in process 2; a kill-the-listen-connection test proving reconnect + `re-LISTEN`
  **bumps the generation** and a post-gap cursor forces resync; the in-process/SQLite path proven
  to publish **after** commit (a writer→refetch race that must re-cache post-write state); a
  replica-lag test proving the post-invalidation refetch observes the write. 100% coverage on the
  transport core; only the irreducible socket/`pg.Client` wiring is coverage-excluded (the
  ADR 0032 pattern — logic in a covered module).
- **Phase B:** an e2e test — two clients, a mutation in A delivers `invalidate` to B with **no app
  socket code**; same-origin-only (a cross-site `EventSource` gets no cookie → public topics
  only); per-topic authz (a viewer is denied an operator-only topic, by code); re-auth/TTL (a
  revoked principal's stream is severed); **disconnect/replay** (brief blip → precise replay from
  the cursor; long gap or **reconnect to a different `instanceId`** → exactly one `resync`, proving
  the cross-node hole is closed); backpressure (a stalled client is dropped to resync without
  blocking others) **with an asserted invariant that the hub callback returns synchronously and
  never awaits the socket**; heartbeat-keeps-alive; the client consumer is tree-shaken out of the
  default island bundle (bundle-size gate).
- **The QA gate (`L-a34a410e`):** an `examples/` app demonstrating live `useQuery` that **runs
  locally and deploys**, per the gallery-as-QA-gate rule.

## Reviews

### 2026-06-27 — red-team (multi-lens) + chief-architect, grounded in the seams

Both passes verified the cited code. The core decision — transport-behind-a-seam, `(topic,
cursor)`-only wire, SSE over WS, edge-DO last — was endorsed; it faithfully upholds ADR 0027's
no-data invariant and stays out of the Tier 4 local-first lane. **Verdicts:** red-team **REVISE**
(two decision-affecting Criticals); chief-architect **RATIFY-WITH-CHANGES** (five must-changes).
This draft is the revision. What changed:

- **`seq` ordering (Critical, red-team C1/C2).** A Postgres `SEQUENCE`/`txid` is monotonic by
  call order, not commit order; `NOTIFY` delivers in commit order, so the old resume cursor could
  permanently skip a write, and a node's own listen-reconnect gap left undetectable holes.
  **Fixed:** the cursor is a node-local `(generation, index)` over the commit-ordered delivery
  stream; correctness rests on **resync-by-default**, with precise replay only when a continuity
  proof holds. No fleet-global id.
- **"No new server primitive" (Critical, red-team S3/O1/O5/P1).** Streams hold an in-flight slot
  (self-DoS at ~1k), default compression buffers `text/event-stream`, and the access log defers to
  teardown. **Fixed:** a first-class long-lived-stream response kind (claim retracted).
- **Timeout/abort collision (chief-arch #1 risk, red-team P4).** `context.signal` doubles as the
  30s `handlerTimeoutMs` abort (the earlier `requestTimeoutMs`/`headersTimeoutMs` premise was
  wrong). **Fixed:** exempt long-lived streams from `handlerTimeoutMs`; distinguish disconnect vs
  timeout by reason code.
- **Seam overload (chief-arch #1).** Transports must not live inside dependency-free
  `@lesto/pubsub`. **Fixed:** new app-wired `@lesto/realtime` composing layer; the seam is a
  transport interface; `publish`'s count is documented local-only; app-wired (not kernel-wired).
- **Post-commit DB hook (chief-arch #3, red-team C4).** Over-reach. **Fixed:** cut; caller-ordering
  + free PG `NOTIFY`-in-tx; `L-c5beede7` re-scoped.
- **Connect-time-only authz (red-team S1).** **Fixed:** interval re-auth + bounded TTL +
  revocation severs the stream.
- **Origin doesn't transfer to SSE (red-team S2, chief-arch nit).** **Fixed:** same-origin grounded
  in SameSite cookies + no-CORS; the ADR 0032 "mirror" downgraded to "the idea only," citing the
  production `/__lesto/*` receivers.
- **Replica lag / read-your-writes (red-team C3).** **Added** as an explicit deployment constraint.
- **Backpressure / slow consumer (chief-arch #4).** **Added** per-connection bounded queues
  (overflow → resync that one connection).
- **Client consumer placement (chief-arch #5).** **Specified:** `@lesto/ui`, opt-in,
  tree-shakeable.
- **Honesty fixes:** HTTP/1.1 cap is per-origin (not per-tab); thundering herd acknowledged +
  coalescing seam named; NOTIFY throughput ceiling noted; "all rings identical" → converge-on-tail
  + resync floor.

### 2026-06-30 — focused re-review of the revision (both lenses) → ratified

The revised draft was re-reviewed against the two Criticals specifically, grounded in the code.
**Chief-architect: RATIFY** — verified all five must-changes were genuinely addressed (packaging,
timeout/abort, cut DB hook, client-consumer placement, honesty fixes), every cited seam re-checked;
would sign off. **Red-team: REVISE-AGAIN** — confirmed the runtime changes are necessary and
achievable and that most cursor attack-paths are now closed, but found **two remaining items**, both
bounded edits within the design, now folded in:

- **Cursor lacked node identity (decision-affecting).** The node-local `(generation, index)` cursor
  reuses the same space across nodes, so a client reconnecting to a *different* node (non-sticky LB)
  gets a **false continuity proof** and silently misses the frames it dropped — the same failure
  class the round-1 fix claimed to close. **Fixed:** the cursor is now `(instanceId, generation,
  index)`; precise replay requires `cursor.instanceId == thisProcess.instanceId`, else resync.
- **In-flight-gate exemption removed the only global stream backstop (partially decision-affecting).**
  The per-principal cap is incomplete — no global ceiling, and the anonymous bucket collapses to one
  shared principal. **Fixed:** a dedicated **global max-concurrent-streams semaphore** + an
  **IP-keyed anonymous bucket**; the exemption is implemented as a **route predicate** (not a
  response flag, which would double-free the unconditional `finally` release).

Minor notes also folded in: the **non-blocking-listener invariant** (the SSE hub callback must
enqueue-and-return, never await the socket — else it reintroduces the self-DoS); `invalidateTopic`
(not `invalidate`) as the consumer's call; re-auth **re-resolves session validity** rather than
re-reading the entry-time principal; caller-ordering's **early-publish** failure is non-resync-
recoverable (guarded by lint+test, not just documented); timeout-exemption downgraded to
defense-in-depth; the single-channel NOTIFY fan-in ceiling and the same-node/sticky nature of the
replay ring stated honestly.

**Verdict: ratified 2026-06-30.** The core decision was endorsed by both passes across both rounds;
the two round-2 fixes are the reviewers' own prescribed remedies, applied verbatim. Build follows
the phased plan (runtime long-lived-stream prereq → `@lesto/realtime` + PG transport → SSE fan-out →
edge DO).
