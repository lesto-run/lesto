# Plan: `@lesto/pubsub` live on Cloudflare via a Durable Object

Wave 2 of the "batteries live on CF" initiative ([[batteries-edge-demos]], epic
**L-d7c0841c**; this task **L-f69f0e56**). The FIRST Durable Object substrate in
the framework. Ratified design, **adversarially reviewed + revised** (see the
red-team note below) — execute largely verbatim.

Wave 1 precedent to match: `examples/cache` (edge over D1) + `examples/mail`
(Email Sending) — each ships `worker.ts` + `alchemy.run.ts` (with a folded-in
post-deploy smoke) + a `deploy-examples.yml` step + an honest README + a local
test. Cache's smoke is a **behavioral** proof (a warm D1-backed hit); this one
must clear the same bar — behaviorally prove cross-isolate fan-out.

## Red-team revision (what changed from the first draft)
- **The fan-out core moved from `@lesto/cloudflare` to `@lesto/pubsub`.** It is a
  general safe-fan-out-over-sockets primitive with a transport-neutral
  `{ send(data: string): void }` seam and ZERO Cloudflare specifics — a pubsub
  concept, not an edge-adapter concept. Three reasons the original home was wrong:
  (1) the Node `serve.ts` would have had to import the *Cloudflare edge adapter*
  to get it — backwards; (2) ADR 0040 reserves the `@lesto/cloudflare` slot for
  the **topic-only realtime `Transport`** (the invalidation bus), which is a
  *different* thing from this **general-message** fan-out (decision A2), so that
  justification was misapplied; (3) it kept `@lesto/cloudflare` from gaining a
  battery dependency. `@lesto/pubsub` is dependency-free with a 100% gate, so the
  core is tested there and both the DO and `serve.ts` import it from a neutral leaf.
- **Refuted (dropped) finding:** "published `@lesto/cloudflare` → unpublished
  `@lesto/pubsub` is a release closure-blocker." Both are `0.1.3`/public, and
  `@lesto/runtime` already depends on `@lesto/queue` (a battery) the same way — a
  release-handled pattern, not a blocker. (Moot now anyway: the core lives in
  pubsub, so no new cross-package edge is created.)
- **Two invariants made explicit** (see ⚠️ below): the `add`-before-`101` ordering
  (kills a smoke race) and the `publish` count semantics.

## Why a DO
`@lesto/pubsub`'s `PubSub` is an in-process hub (per-isolate memory). On CF there
is no shared memory across isolates, so cross-isolate fan-out needs a coordination
point — a Durable Object. There is no simpler CF primitive for cross-isolate
WebSocket fan-out (Queues aren't real-time WS fan-out; CF Pub/Sub is MQTT). The DO
is necessary, not incidental.

## Ratified decisions

| # | Decision | Rationale |
|---|---|---|
| **A** | **General-message DO fan-out** (arbitrary JSON payloads), NOT the realtime topic-only `Transport`. | This is the *pubsub* battery (`publish(channel, message)`, arbitrary). Riding the topic-only realtime bus would demo `@lesto/realtime` (already covered by `examples/reactive`). **Not an ADR 0027 violation** — that "topics only, never row data" invariant scopes to the realtime reactive-data seam; `@lesto/pubsub` is a separate general hub. Honest caveat: no built-in authz → README flags it. |
| **B** | **Pure core in `@lesto/pubsub`** (`packages/pubsub/src/fanout.ts`: `FanoutRoom` + `FanoutSocket` seam + codec — dependency-free, transport-neutral, 100%-covered under pubsub's existing gate). **DO class in the example** (`examples/pubsub/room.ts`, workerd-only wiring, coverage-exempt). | Brain tested in the package (mirrors `pg-transport.ts`); socket plumbing beside its only workerd consumer (mirrors `OpenAuthKeyStore`). The `FanoutSocket` seam (`{ send(string) }`) is satisfied structurally by a workerd `WebSocket` server end AND a Bun `ServerWebSocket`, so the SAME core serves the edge DO and the Node `serve.ts`. |
| **C** | **WebSocket end-to-end, terminated inside the DO, non-hibernating.** Browser opens `wss://…/subscribe?channel=…` → Worker proxies the upgrade to the DO stub (`stub.fetch(request)`); publish is `POST /publish` → Worker → same stub. | SSE reuse is out (topic-only, no client→server). Non-hibernating keeps the real in-process `PubSub` hub inside the DO (the demo's thesis) — hibernation would replace it with a bare socket loop. Hibernation is the documented production graduation. |
| **D** | **One named DO per app** (`ns.idFromName("hub")`), multiplexing channels through the in-memory `PubSub`. | Matches the `OpenAuthKeyStore` single-instance precedent; guarantees publisher + subscriber rendezvous at one instance regardless of isolate — an airtight cross-isolate proof. Per-channel sharding (`idFromName(channel)`) is the documented scaling step. |
| **E** | **Ephemeral in-memory fan-out; no `state.storage`.** | The demo proves *live* fan-out. A persisted `ReplayRing` for missed-message resume is the documented shipped-substrate extension. (`sqlite: true` is still declared on the namespace — harmless with no storage, and future-proofs the ReplayRing step.) |
| **F** | **Smoke = a real WS subscriber receives a fresh nonce published by a separate HTTP request, through the DO.** | Falsifiable (random nonce per run); stronger than cache's — a socket terminated in the DO can only be reached via the DO, so the cross-isolate path is exercised even if both HTTP legs hit one isolate. |
| **G** | **Brain unit-tested against a fake `FanoutSocket` (100%, in `@lesto/pubsub`); DO/WS wiring example-local (coverage-exempt).** | pubsub keeps 100% with no new exclusion; the example's `serve.smoke.test.ts` gives the real-socket proof over Node. |

### ⚠️ Load-bearing correctness invariants
1. **Throwing-listener hazard.** `PubSub.publish` (`packages/pubsub/src/pubsub.ts:81-85`) snapshots listeners (`[...listeners]`) then `await`s each in a loop with **no try/catch** — a throwing listener aborts fan-out to everyone after it. So `FanoutRoom.add`'s registered listener MUST wrap `socket.send` in try/catch and **self-unsubscribe on failure, never throwing**. Because `publish` snapshots first, a listener calling its own `off()` mid-delivery is safe. Explicit covered test.
2. **`add`-before-`101` ordering (no smoke race).** In the DO's upgrade handler, `#room.add(...)` MUST run **before** the `Response(101)` is returned. The client's WebSocket `open` fires only after it receives that 101, so the socket is guaranteed registered before any post-`open` publish arrives — no "publish races subscription" gap. Do not reorder.
3. **`publish` count semantics.** `FanoutRoom.publish` returns `PubSub.publish`'s count = the snapshot length, i.e. subscribers the message was **dispatched to**. A socket that throws mid-send is dropped but still counted for that call (the snapshot was taken before the throw). The smoke therefore asserts actual **receipt** on the socket, not just `delivered >= 1`, so the count is a diagnostic, not the proof. Document this on the method.

## Build sequence

**Package (`@lesto/pubsub`) — independently mergeable, stays 100%:**
1. `packages/pubsub/src/fanout.ts` (new) — the pure core:
   - `interface FanoutSocket { send(data: string): void }`
   - `interface FanoutFrame { type: "message"; channel: string; seq: number; data: unknown }`
   - `function encodeFrame(frame: FanoutFrame): string`
   - `interface PublishRequest { channel: string; message: unknown }`
   - `function parsePublishBody(raw: unknown): PublishRequest | undefined` (non-empty string channel + a `message` key; `undefined` on anything malformed → 400)
   - `class FanoutRoom { constructor(opts?: { hub?: PubSub }); add(socket: FanoutSocket, channel: string): () => void; publish(channel: string, message: unknown): Promise<number>; subscriberCount(channel: string): number }`
     - `add` listener: `(payload) => { try { socket.send(encodeFrame({ type:"message", channel, seq: payload.seq, data: payload.data })) } catch { off() } }` (invariant 1).
     - `publish`: `const seq = ++this.#seq; return this.#hub.publish(channel, { seq, data: message })` (invariant 3).
2. `packages/pubsub/src/index.ts` — export `FanoutRoom`, `encodeFrame`, `parsePublishBody` + the types.
3. `packages/pubsub/test/fanout.test.ts` (new) — 100%: N-subscriber fan-out; two-channel isolation; close-thunk stops delivery; **a throwing socket is dropped AND later subscribers still receive** (invariant 1, driven by a recording fake + a throwing fake `FanoutSocket`); `publish` count; `parsePublishBody` valid + each malformed shape; `encodeFrame` round-trip. No change to `packages/pubsub/vitest.config.ts`. *(No `package.json` dep change — pubsub stays dependency-free; the core uses the same package's `PubSub`.)*

**Example (`examples/pubsub/`) — behavioral-only:**
4. `package.json` + `tsconfig.json` (mirror `examples/cache`; deps `@lesto/pubsub`; devDeps `@cloudflare/workers-types` + `alchemy`; `lib` includes DOM for WS globals; `include` room.ts + worker.ts + alchemy.run.ts).
5. `src/app.ts` — `buildFanoutServer(): { room: FanoutRoom; fetch; websocket }` (substrate-neutral Bun handlers, reused by serve + test). `GET /subscribe` → `srv.upgrade(req,{data:{channel}})`; `websocket.open` → `ws.__off = room.add(ws, ws.data.channel)`; `websocket.close` → `ws.__off()`; `POST /publish` → `parsePublishBody` → `room.publish` → `Response.json({ delivered })`. On Node the single process IS the coordination point (the DO's job on CF).
6. `room.ts` — `class PubSubRoom { #room = new FanoutRoom(); constructor(_state: DurableObjectState){} async fetch(req) {...} }`: upgrade → `new WebSocketPair()` + `server.accept()` + **`const off = #room.add({ send: d => server.send(d) }, channel)` (before the 101 — invariant 2)** + `server.addEventListener("close"|"error", off)` + `return new Response(null,{status:101, webSocket: client})`; `POST /publish` → `parsePublishBody(await req.json())` → 400 if invalid else `Response.json({ delivered: await #room.publish(...) })`. Imports `FanoutRoom`/`parsePublishBody` from `@lesto/pubsub`.
7. `worker.ts` — `export { PubSubRoom } from "./room"` (workerd resolves the DO class from entry exports); `fetch` routes `/subscribe` + `/publish` to `ns.get(ns.idFromName("hub")).fetch(request)`; `GET /` inline demo HTML. No per-isolate memo — the stateful piece is the DO; the Worker is pure routing (honest deviation from wave-1's `toFetchHandler` memo, noted in README).
8. `serve.ts` — `Bun.serve({ port, fetch, websocket })` from `buildFanoutServer()` (Bun native WS, precedent: `packages/cli/src/bin.ts` dev-MCP `srv.upgrade` + `websocket`; NOT `serveWithGracefulShutdown`, which is node:http/no-WS); log `listening on http://127.0.0.1:<port>`; SIGINT/SIGTERM → `server.stop()` + exit 0.
9. `test/pubsub.test.ts` (new) — in-process over `FanoutRoom`/fake sockets: two subscribers both receive; other-channel does not; closed subscriber stops.
10. `test/serve.smoke.test.ts` (new) — clone `examples/cache/test/serve.smoke.test.ts` (confirmed to exist): spawn `bun run serve.ts` (PORT=0, DRAIN child stdio per [[undrained-child-stdio-stalls-dev-server]]), parse the listening URL, open a real `WebSocket` to `/subscribe?channel=smoke`, `POST /publish` a nonce, assert receipt, SIGTERM, assert exit 0.
11. `alchemy.run.ts` (new) — `alchemy("lesto-example-pubsub",{ stateStore: CloudflareStateStore })`; `Worker("pubsub-edge",{ entrypoint:"worker.ts", bindings:{ PUBSUB_ROOM: DurableObjectNamespace("pubsub-room",{ className:"PubSubRoom", sqlite:true }) }, url:true, compatibilityDate:"2025-06-01" })`; after `finalize()`, `verifyLive(url)` (the smoke below). **`compatibilityFlags: ["nodejs_compat"]` is OPTIONAL here** — the pubsub worker uses no node builtins (pubsub is dependency-free, FanoutRoom is pure, the DO uses workerd globals); include it only for wave-1 consistency, or drop it.
12. `README.md` (new) — honest posture (below).

**CI:**
13. `.github/workflows/deploy-examples.yml` — add an `example-pubsub` deploy step after `example-mail` (same secrets/stage shape).

Order: 1→2→3 (package core lands + green under the 100% gate independently) → 4,5 → 6,7,8 → 9,10 → 11 → 12 → 13.

## The smoke (`verifyLive` in `alchemy.run.ts`)
1. `nonce = crypto.randomUUID()` (fresh per run → the assertion can fail; not a workflow script, so `crypto` is available).
2. Open `new WebSocket(url→ws + "/subscribe?channel=smoke")` with connect-retry-backoff `[500,1000,2000,4000,8000]` (cold start / propagation); await open.
3. Handler resolves when a frame's `data` contains `nonce`.
4. `POST /publish {channel:"smoke", message:{nonce}}`; assert HTTP 200 (`delivered` is diagnostic, per invariant 3).
5. `Promise.race([received, timeout(10_000)])`; timeout → **throw** `smoke: subscriber never received the published nonce → fan-out broken`.
6. Close socket; log `smoke: DO-mediated fan-out — subscriber received nonce <…> ✓`.

## Honest claims
- ✅ **Live + machine-checked, no manual hop:** the Worker AND its Durable Object deploy live, and a real WS subscriber receives a message published by a separate request through the DO — genuine cross-connection, DO-mediated fan-out.
- ✋ **Caveats (README):** no authz on subscribe/publish (app's job); single per-app DO instance + non-hibernating (throughput ceiling + bills wall-clock while a socket is open); no missed-message resume. Production graduation = per-channel sharding + WebSocket hibernation + a `state.storage`-backed `ReplayRing` — documented follow-ups.

## Risks (verified)
- DO + `sqlite:true` already proven in the CI target account (`OpenAuthKeyStore` via `examples/mcp-auth-openauth`). Alchemy auto-generates the DO migration; the class MUST be exported from the Worker entrypoint (`export { PubSubRoom } from "./room"`).
- Non-hibernation bills the DO while sockets are open (negligible for the smoke; the reason to graduate). If ALL sockets close the DO may evict and lose its in-memory hub — expected (no persistence). Hibernation later needs `serializeAttachment`/`state.storage`, `webSocketMessage/Close/Error` handlers, `getWebSockets()`.
- CF error 1042 (same-account workers.dev→workers.dev subrequest refusal) does NOT apply — the smoke client is the CI runner (external), not a Worker subrequest.
- Backpressure: a slow socket's outbound queue is unbounded (workerd buffers `send`); the realtime SSE path's `maxQueue` is the model for the production substrate. Noted, not built.
- Bun/Node global `WebSocket` client is used by both the local smoke and the CF smoke (both run under `bun`) — no `ws` dependency.
