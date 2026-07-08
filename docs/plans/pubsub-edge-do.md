# Plan: `@lesto/pubsub` live on Cloudflare via a Durable Object

Wave 2 of the "batteries live on CF" initiative ([[batteries-edge-demos]], epic
**L-d7c0841c**; this task **L-f69f0e56**). The FIRST Durable Object substrate in
the framework. Ratified design — execute largely verbatim.

Wave 1 precedent to match: `examples/cache` (edge over D1) + `examples/mail`
(Email Sending) — each ships `worker.ts` + `alchemy.run.ts` (with a folded-in
post-deploy smoke) + a `deploy-examples.yml` step + an honest README + a local
test. Cache's smoke is a **behavioral** proof (a warm D1-backed hit); this one
must clear the same bar — behaviorally prove cross-isolate fan-out.

## Why a DO
`@lesto/pubsub`'s `PubSub` is an in-process hub (per-isolate memory). On CF there
is no shared memory across isolates, so cross-isolate fan-out needs a coordination
point — a Durable Object. ADR 0040's `Transport` seam docstring already reserved
"the edge Durable-Object implementation in `@lesto/cloudflare`" for exactly this.

## Ratified decisions

| # | Decision | Rationale |
|---|---|---|
| **A** | **General-message DO fan-out** (arbitrary JSON payloads), NOT the realtime topic-only `Transport`. | This is the *pubsub* battery (`publish(channel, message)`, arbitrary). Riding the topic-only realtime bus would demo `@lesto/realtime` (already covered by `examples/reactive`). **Not an ADR 0027 violation** — that "topics only, never row data" invariant scopes to the realtime reactive-data seam; `@lesto/pubsub` is a separate general hub. Honest caveat: no built-in authz → README flags it as the app's job. |
| **B** | **Pure core in `@lesto/cloudflare`** (`FanoutRoom` + `FanoutSocket` seam + codec — a plain `{ send(data:string):void }` seam, no `@cloudflare/workers-types`, node-buildable, 100%-coverable). **DO class in the example** (`examples/pubsub/room.ts`, workerd-only wiring, coverage-exempt). | Brain tested in the package (mirrors `pg-transport.ts`); socket plumbing beside its only consumer (mirrors `OpenAuthKeyStore`). No new vitest exclusion. Promote the DO class into the package when a 2nd consumer appears (YAGNI now). |
| **C** | **WebSocket end-to-end, terminated inside the DO, non-hibernating.** Browser opens `wss://…/subscribe?channel=…` → Worker proxies the upgrade to the DO stub (`stub.fetch(request)`); publish is `POST /publish` → Worker → same stub. | SSE reuse is out (topic-only, no client→server). Non-hibernating keeps the real in-process `PubSub` hub inside the DO (the demo's whole thesis) — hibernation would replace it with a bare socket loop. Hibernation is the documented production graduation. |
| **D** | **One named DO per app** (`ns.idFromName("hub")`), multiplexing channels through the in-memory `PubSub`. | Matches the `OpenAuthKeyStore` single-instance precedent; guarantees publisher + subscriber rendezvous at one instance regardless of isolate — an airtight cross-isolate proof. Per-channel sharding (`idFromName(channel)`) is the documented scaling step. |
| **E** | **Ephemeral in-memory fan-out; no `state.storage`.** | The demo proves *live* fan-out. A persisted `ReplayRing` for missed-message resume is the documented shipped-substrate extension. |
| **F** | **Smoke = a real WS subscriber receives a fresh nonce published by a separate HTTP request, through the DO.** | Falsifiable (random nonce per run); stronger than cache's — a socket terminated in the DO can only be reached via the DO, so the cross-isolate path is exercised even if both HTTP legs hit one isolate. |
| **G** | **Brain unit-tested against a fake `FanoutSocket` (100%); DO/WS wiring example-local (coverage-exempt).** | `@lesto/cloudflare` keeps 100% with no new exclusion; the example's `serve.smoke.test.ts` gives the real-socket proof over Node. |

### ⚠️ Load-bearing correctness constraint
`PubSub.publish` (`packages/pubsub/src/pubsub.ts:81`) `await`s listeners in a loop
with **no try/catch** — a throwing listener aborts fan-out to everyone after it. A
dead socket's `send()` throw would starve later subscribers. So `FanoutRoom.add`'s
registered listener MUST wrap `socket.send` in try/catch and **self-unsubscribe on
failure, never throwing**. This is an explicit covered test.

## Build sequence

**Package (`@lesto/cloudflare`) — independently mergeable, stays 100%:**
1. `packages/cloudflare/src/durable-fanout.ts` — `FanoutRoom` (`add(socket,channel) => off`, `publish(channel,message) => Promise<count>`, `subscriberCount`), the `FanoutSocket` seam, `encodeFrame`, `parsePublishBody` (validate untrusted body → `undefined` on malformed). `add`'s listener: `try { socket.send(encodeFrame(...)) } catch { off() }`.
2. `packages/cloudflare/src/index.ts` — export the above.
3. `packages/cloudflare/package.json` — add `@lesto/pubsub: workspace:*` (dependency-free, no cycle).
4. `packages/cloudflare/test/durable-fanout.test.ts` — 100%: N-subscriber fan-out; two-channel isolation; close-thunk stops delivery; **throwing socket dropped + later subscribers still receive**; publish count; `parsePublishBody` valid/each-malformed; `encodeFrame` round-trip.

**Example (`examples/pubsub/`) — behavioral-only:**
5. `package.json` + `tsconfig.json` (mirror `examples/cache`; deps `@lesto/cloudflare` + `@lesto/pubsub`; devDeps `@cloudflare/workers-types` + `alchemy`; `lib` includes DOM for WS globals; `include` room.ts + worker.ts + alchemy.run.ts).
6. `src/app.ts` — `buildFanoutServer()` → `{ room, fetch, websocket }` (substrate-neutral Bun handlers; reused by serve + test). On Node the single process is the coordination point.
7. `room.ts` — `class PubSubRoom { #room = new FanoutRoom(); async fetch(req) {...} }`: upgrade → `WebSocketPair` + `server.accept()` + `off = #room.add({send:d=>server.send(d)},channel)` + close/error → `off()`; `POST /publish` → `parsePublishBody` → `#room.publish`. Delegates all logic to `FanoutRoom`.
8. `worker.ts` — `export { PubSubRoom } from "./room"` (workerd resolves the class from entry exports); `fetch` routes `/subscribe` + `/publish` to `ns.get(ns.idFromName("hub")).fetch(request)`; `GET /` inline demo HTML. (No per-isolate memo — the stateful piece is the DO; the Worker is pure routing.)
9. `serve.ts` — `Bun.serve({ fetch, websocket })` from `buildFanoutServer()` (Bun native WS, following `packages/cli/src/bin.ts:785`; not `serveWithGracefulShutdown`, which is node:http/no-WS); log `listening on http://127.0.0.1:<port>`; SIGINT/SIGTERM → `server.stop()` + exit 0.
10. `test/pubsub.test.ts` — in-process over `FanoutRoom`/fake sockets: two subscribers both receive; other-channel does not; closed subscriber stops.
11. `test/serve.smoke.test.ts` — spawn `bun run serve.ts` (PORT=0), real `WebSocket` to `/subscribe`, `POST /publish` a nonce, assert receipt, SIGTERM, exit 0 (clone of `examples/cache/test/serve.smoke.test.ts`).
12. `alchemy.run.ts` — `alchemy("lesto-example-pubsub", { stateStore: CloudflareStateStore })`; `Worker("pubsub-edge", { entrypoint:"worker.ts", bindings:{ PUBSUB_ROOM: DurableObjectNamespace("pubsub-room",{ className:"PubSubRoom", sqlite:true }) }, url:true, compatibilityDate:"2025-06-01", compatibilityFlags:["nodejs_compat"] })`; after `finalize()`, `verifyLive(url)` (the smoke below).
13. `README.md` — honest posture (below).

**CI:**
14. `.github/workflows/deploy-examples.yml` — add an `example-pubsub` deploy step after `example-mail` (same secrets/stage shape).

Order: 1→4 (package unit) → 5,6 → 7,8,9 → 10,11 → 12 → 13 → 14.

## The smoke (`verifyLive` in `alchemy.run.ts`)
1. `nonce = crypto.randomUUID()` (fresh per run → the assertion can fail).
2. Open `new WebSocket(url→ws + "/subscribe?channel=smoke")` with connect-retry-backoff `[500,1000,2000,4000,8000]` (cold start / propagation); await open.
3. Handler resolves when a frame's `data` contains `nonce`.
4. `POST /publish {channel:"smoke", message:{nonce}}`; assert `delivered >= 1`.
5. `Promise.race([received, timeout(10_000)])`; timeout → **throw** `smoke: subscriber never received the published nonce → fan-out broken`.
6. Close socket; log `smoke: DO-mediated fan-out — subscriber received nonce <…> ✓`.

## Honest claims
- ✅ **Live + machine-checked, no manual hop:** the Worker AND its Durable Object deploy live, and a real WS subscriber receives a message published by a separate request through the DO — genuine cross-connection, DO-mediated fan-out.
- ✋ **Caveats (README):** no authz on subscribe/publish (app's job); single per-app DO instance + non-hibernating (throughput ceiling + bills wall-clock while a socket is open); no missed-message resume. Production graduation = per-channel sharding + WebSocket hibernation + a `state.storage`-backed `ReplayRing` — documented follow-ups.

## Risks (verified)
- DO + `sqlite:true` already proven in the CI target account (`OpenAuthKeyStore`). Alchemy auto-generates the DO migration; the class MUST be exported from the Worker entrypoint.
- Non-hibernation bills the DO while sockets are open (negligible for the smoke; the reason to graduate). Hibernation later needs `serializeAttachment`/`state.storage`, `webSocketMessage/Close/Error` handlers, `getWebSockets()`.
- CF error 1042 (same-account workers.dev→workers.dev subrequest refusal) does NOT apply — the smoke client is the CI runner (external), not a Worker subrequest.
- Backpressure: a slow socket's outbound queue is unbounded (workerd buffers `send`); the realtime SSE path's `maxQueue` is the model for the production substrate. Noted, not built.
