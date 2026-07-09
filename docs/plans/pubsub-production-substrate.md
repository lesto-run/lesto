# Plan: `@lesto/pubsub` — graduating the edge fan-out DEMO into a production substrate

Follows `docs/plans/pubsub-edge-do.md` (the ratified demo, shipped `498dc57`/`c48f312`,
**L-f69f0e56**). That doc's "Honest claims" names five deliberate simplifications and
their graduation paths; this doc **ratifies the design of all five** and the one
reshape that unlocks three of them. It is the parent design for the child tasks
under **L-98081669**.

Read the demo doc first — this doc assumes its decisions (A–G) and its three
load-bearing invariants, and only records what **changes**.

## Why (the one-paragraph thesis)
The demo proves *live* cross-isolate fan-out through one non-hibernating Durable
Object holding an in-memory `FanoutRoom`. That is honest and machine-checked, but
it (a) bills wall-clock while any socket is open and loses its hub on eviction,
(b) funnels every channel through one instance, (c) drops any message a subscriber
was offline for, (d) lets anyone read or write any channel, and (e) buffers a slow
socket without bound. A production substrate fixes all five **without abandoning
the two properties that make the demo trustworthy**: a dependency-free, 100%-covered
transport-neutral core in `@lesto/pubsub`, and the SAME core behind both the edge
DO and the Node/Bun server.

The pivot is **WebSocket hibernation**. Hibernation evicts the DO between events,
so the in-memory `PubSub` of listener *closures* cannot survive — under hibernation
**the workerd runtime (`state.getWebSockets(tag)`) IS the subscriber registry.**
That reshapes the core: the closure-holding `FanoutRoom` is retired in favour of a
**pure `fanout()` loop over an injected socket iterable** plus a Node-only
`FanoutRegistry`. Everything else in this doc is downstream of that reshape or
orthogonal to it.

## The reshape (the pivot — read this before the table)
`FanoutRoom` today does two jobs: it **is the registry** (a `PubSub` mapping
channel → a `Set` of listener closures) and it **runs the send policy** (frame,
`send`, drop-on-throw). Hibernation externalises the registry to workerd, so the
two jobs split:

- **The registry becomes substrate-specific and injected.** Edge: workerd holds
  the sockets (`state.acceptWebSocket(ws, [channel])`; enumerate with
  `state.getWebSockets(channel)`). Node: a plain `Map<string, Set<FanoutSocket>>`.
  Neither leaks into the package.
- **The send policy stays the pure, shared, 100%-covered brain**, but as a
  *function over an iterable of sockets*, not a method on a stateful hub:

  ```ts
  // packages/pubsub/src/fanout.ts (reshaped — still dependency-free, transport-neutral)
  export interface FanoutSocket {
    send(data: string): void;
    /** Bytes queued but unsent. workerd + Bun expose it; `undefined` ⇒ backpressure not enforced. */
    readonly bufferedAmount?: number;
  }
  export interface FanoutResult {
    readonly delivered: number;               // sockets the frame was successfully written to
    readonly failed: readonly FanoutSocket[]; // threw on send, or over the buffer bound (item 5)
  }
  export function fanout(
    sockets: Iterable<FanoutSocket>,
    frame: FanoutFrame,
    opts?: { readonly maxBufferedBytes?: number },
  ): FanoutResult;                             // encode once; per-socket try/send; swallow throws; report failed

  export class FanoutRegistry {                // Node/Bun in-memory registry (NOT used by the edge DO)
    add(channel: string, socket: FanoutSocket): () => void;
    socketsFor(channel: string): Iterable<FanoutSocket>;
    drop(channel: string, socket: FanoutSocket): void;
    subscriberCount(channel: string): number;
  }
  ```

`encodeFrame`, `parsePublishBody`, `FanoutFrame`, `PublishRequest` are unchanged.
The **seq counter leaves the core**: it is now the caller's (Node keeps an
in-process `let seq = 0`; the edge DO keeps a *durable* counter — see item 1/3),
because a per-room in-memory counter is exactly the thing that cannot survive
hibernation. `FanoutRoom` (the class) is **retired**; both in-repo consumers
migrate to `fanout` + `FanoutRegistry`. The pure-brain-in-package / 100% / no-new-
exclusion constraint (demo decisions B and G) is **preserved verbatim** — only the
shape of the brain changes, and the change makes it *smaller and more honest*
(invariant 1 becomes a property of one pure function; there is no self-mutating
closure).

Why the SAME core still serves both: the only thing both substrates share is "given
a set of sockets and a frame, write it to each, don't let one dead socket abort the
rest, and tell me who failed." That is `fanout()`. Registry ownership is precisely
the thing that legitimately differs between a single-process server (it owns the
`Set`) and a hibernatable DO (workerd owns the sockets), so injecting it is correct,
not a compromise.

## Ratified decisions

| # | Decision | Rationale |
|---|---|---|
| **R (reshape)** | **Retire the closure-holding `FanoutRoom`; split it into a pure `fanout(sockets, frame, opts)` loop + a Node-only `FanoutRegistry`.** Seq leaves the core to the (substrate-specific) caller. | Hibernation makes workerd the registry; a class that holds listener closures cannot survive eviction. The shared brain shrinks to the send policy, which is genuinely common to both substrates. Preserves demo decisions B + G (pure brain, 100%, no new exclusion). This is a DEVIATION from demo decision C's "keep the in-memory `PubSub` hub" — expected; C was the demo's thesis, not a production invariant. |
| **1 — Hibernation** | **`state.acceptWebSocket(server, [channel])` + `webSocketMessage/Close/Error` handlers + fan-out via `state.getWebSockets(channel)`; the seq counter becomes DURABLE (`state.storage`).** Tag every socket with its channel so the DO is correct with OR without per-channel sharding. | An idle room then costs nothing and survives eviction. Durable seq is folded in here (not deferred to item 3) because a hibernating DO with an in-memory seq *rewinds its seq on every eviction* — a wart worth ~5 lines to kill at the source, and it de-risks the ReplayRing. Uses tags (not the untagged `getWebSockets()`) so it does not assume sharding has landed. |
| **2 — Per-channel sharding** | **`ns.idFromName(channel)` instead of `idFromName("hub")`.** The Worker extracts the channel from the query (`/subscribe`) and the body (`/publish`), routes to the channel's DO, and `seq` is now naturally per-channel. **Zero package change.** | One DO per channel lifts the single-instance throughput ceiling while KEEPING the cross-isolate proof (both legs for channel X still rendezvous at `idFromName(X)`). DEVIATION from demo decision D (one named DO); the demo already named this the scaling step. Independent of the reshape — buildable now. |
| **3 — Missed-message resume (ReplayRing)** | **A `state.storage` sqlite ring per channel-DO + `/subscribe?...&since=<seq>` replay.** Bounded by count **and** age; replay-then-live with **client-side seq dedup** as the always-correct floor. Reads the durable seq item 1 introduced. | Lets a briefly-disconnected client catch up. DEVIATION from demo decision E (no `state.storage`). Blocked-by item 1 (needs the hibernating shape + durable seq). Mirrors `packages/realtime/src/replay-ring.ts`, but **simpler**: one DO is the sole strongly-consistent monotonic owner of its channel's seq, so there is no `instanceId`/`generation` machinery — continuity is provable within the retained window, and below it the client reconnects fresh. |
| **4 — Authz** | **A signed, per-channel, per-mode, short-lived capability token over Web Crypto HMAC-SHA256, verified in the Worker (and mirrored in the Node app) BEFORE forwarding.** New pure module `packages/pubsub/src/channel-token.ts`. NOT a shared-secret env var. | The token models the real pattern (the app's authenticated backend mints `{channel, mode, exp}`, signed with a server secret; the Worker only *verifies*). Web Crypto `crypto.subtle` is a global on workerd, Bun, and Node ≥ 20 — so this stays **dependency-free**, needs **no `nodejs_compat`**, and is 100%-coverable in the package. Independent of the reshape — buildable now. See "Authz: the model decision" below for why not shared-secret and why not `@lesto/webhooks`. |
| **5 — Backpressure** | **A `maxBufferedBytes` bound checked via `socket.bufferedAmount` inside `fanout()`; a socket over the bound is reported in `failed` and CLOSED with a specific code, never buffered without bound.** Modelled on `@lesto/realtime`'s SSE `maxQueue`. | workerd's server `WebSocket` exposes `bufferedAmount` but has **no drain event**, so detection is a *poll at send time*, and the policy is *close-to-resync* (the client reconnects and, with item 3, resumes via `?since=`) — the exact shape realtime uses. Built into the reshaped `fanout()`, so it is soft-blocked-by item 1. |

### ⚠️ Load-bearing correctness invariants
The three demo invariants are **carried forward, re-anchored onto the reshaped core**;
two are added.

1. **Throwing / dead socket is dropped, never rethrown, and never aborts delivery
   to the rest.** Was a property of `FanoutRoom.add`'s listener wrapping `PubSub`'s
   no-try/catch loop; is now a property of **`fanout()`** — it wraps each `send` in
   try/catch, continues the loop, and returns the throwers in `failed`. The caller
   reaps them (Node: `registry.drop(channel, socket)`; edge: workerd already evicts a
   closed socket from its tag set, and `webSocketClose` fires). *Strictly simpler than
   before — no self-mutating closure.* Covered by a throwing fake in the package.
2. **Register before the `101`.** Was `#room.add(...)` before the upgrade Response;
   is now **`state.acceptWebSocket(server, [channel])` before the `101`** (edge) /
   `registry.add(...)` in the Bun `open` handler (Node — Bun fires `open` only after
   the handshake, same guarantee). The client's `open` fires only after it receives
   the `101`, and workerd buffers any `send` to an accepted-but-not-yet-open socket,
   so no publish can race a subscribe. Do not reorder.
3. **`delivered` is a diagnostic, not a receipt — CHANGED semantics.** Was "the
   snapshot length, i.e. subscribers dispatched to (a mid-send thrower is still
   counted)". Is now **`FanoutResult.delivered` = sockets the frame was *successfully
   written to* (throwers and over-buffer sockets are excluded and returned in
   `failed`)**. This is a DEVIATION — there is no pre-taken snapshot under hibernation
   to anchor "dispatched to", and "successfully written" is the honest available
   number. The smoke still asserts **receipt on the socket**, so the count stays a
   diagnostic; the change only makes the diagnostic more truthful.
4. **(NEW) Durable, monotonic, per-channel seq.** The edge seq lives in
   `state.storage` and only ever increments; it never rewinds across eviction. This
   is what makes ReplayRing (`?since=`) meaningful and what a hibernating DO would
   otherwise violate. Node's seq is in-process (single process, no eviction) and
   equally monotonic.
5. **(NEW) A capability token authorizes exactly one `(channel, mode)` and expires.**
   `verifyChannelToken` checks the signature (constant-time, via `crypto.subtle`),
   the requested channel, the requested mode, and `exp` against `now`. A subscribe
   token cannot publish; a token for channel `a` cannot touch channel `b`; an expired
   token is refused. A leaked token is a scoped, short-lived capability, not a master
   credential.

## Authz: the model decision (ratified)
**Chosen: signed per-channel capability token. Rejected: shared-secret env var.**

- **Shared-secret is strictly weaker AND a worse teacher.** One secret grants every
  channel and both modes, so it cannot express the actual production question
  ("*may this principal subscribe to `org:42`?*"). And because browsers cannot set
  headers on a WebSocket upgrade, the secret would ride the query string as a
  **master credential in a URL** — logged by every proxy. Rejected.
- **The capability token** is `base64url(JSON({channel, mode, exp}))` + `"."` +
  `base64url(HMAC-SHA256(payload, secret))`. The app's authenticated backend mints
  it (it already has the session); the browser presents it on the WS URL / the
  publish `Authorization` header; the Worker *verifies* it before forwarding. A
  leaked token is scoped to one channel + mode and is short-lived (a URL-borne
  subscribe token especially so). This is the standard signed-WS-URL pattern.
- **No new dependency, no `nodejs_compat`, stays in `@lesto/pubsub`.** Web Crypto
  `crypto.subtle` is a global on workerd, Bun, and Node ≥ 20. The repo already signs
  HMAC-SHA256 over `crypto.subtle` in dependency-free, edge-safe code:
  `packages/storage/src/sigv4.ts` ("*over Web Crypto … never `node:crypto` or
  `Buffer`*" at line 2; `crypto.subtle.digest` at :51, `importKey` at :174, `sign`
  at :182). That is the pattern to mirror.
- **Why not `@lesto/webhooks`** (it has `sign`/`verify`, `packages/webhooks/src/webhooks.ts:93,128`):
  it is **`node:crypto`-based** (`createHmac`/`timingSafeEqual`, line 1) and drags
  `@lesto/queue` + `@lesto/errors`. Reusing it would force `nodejs_compat` onto the
  Worker and add three deps to a dependency-free example. Its *shape* is the model
  (timestamp-bound HMAC, constant-time compare) — I mirror the shape, not the code.
- **Why not `@lesto/identity`**: it is DB + session + mail (`@lesto/auth`/`db`/
  `migrate`), a node-side auth battery, not a portable edge-verify primitive.

Token module signatures (pure, dependency-free, 100%-covered):

```ts
// packages/pubsub/src/channel-token.ts
export type ChannelMode = "subscribe" | "publish";
export interface ChannelGrant { readonly channel: string; readonly mode: ChannelMode; readonly exp: number; }
export type ChannelTokenFailure = "malformed" | "bad-signature" | "expired" | "wrong-channel" | "wrong-mode";
export type ChannelTokenResult =
  | { readonly ok: true;  readonly grant: ChannelGrant }
  | { readonly ok: false; readonly reason: ChannelTokenFailure };

/** Mint a capability token. Server-side only (the app's issuer holds `secret`). */
export function mintChannelToken(grant: ChannelGrant, secret: string): Promise<string>;

/** Verify a token against the REQUESTED channel + mode + `now`. Never throws — a bad token is data. */
export function verifyChannelToken(
  token: string,
  expected: { readonly channel: string; readonly mode: ChannelMode; readonly now?: number },
  secret: string,
): Promise<ChannelTokenResult>;
```

## Build sequence (each block is a standalone child task)

### Task A — Authz + per-channel sharding (BUILDABLE NOW; independent of the reshape)
Lands on the CURRENT (non-hibernating, `FanoutRoom`-based) example. Touches:

**Package (`@lesto/pubsub`, stays dependency-free + 100%):**
1. `packages/pubsub/src/channel-token.ts` (new) — `mintChannelToken` / `verifyChannelToken`
   over `crypto.subtle` HMAC-SHA256 (mirror `sigv4.ts`'s `importKey`→`sign`; for
   verify, recompute + `crypto.subtle.verify` for a constant-time compare). Wire
   format above. Errors are tagged results, not throws (a malformed token is data).
2. `packages/pubsub/src/index.ts` — export the token API + types.
3. `packages/pubsub/test/channel-token.test.ts` (new, 100%): mint→verify round-trip;
   `wrong-channel`; `wrong-mode`; `expired` (and the `exp === now` boundary);
   tampered payload → `bad-signature`; tampered signature → `bad-signature`;
   malformed (no `.`, bad base64url, non-JSON payload, missing field) → `malformed`.
   No `vitest.config.ts` change; no `package.json` dep change.

**Example (`examples/pubsub/`, behavioral-only, coverage-exempt):**
4. `src/app.ts` — `buildFanoutServer(opts: { secret: string })`. Guard both routes
   with `verifyChannelToken` (mode `subscribe` for `/subscribe`, `publish` for
   `/publish`); `token` from `?token=` on the upgrade URL and from the
   `Authorization: Bearer` header (or `?token=`) on publish; a non-`ok` result →
   `401` **before** any upgrade/publish. This mirrors the Worker so the Node path is
   authenticated too and the guard gets real behavioral coverage.
5. `worker.ts` — the canonical edge guard. Add `PUBSUB_SECRET: string` to `Env`.
   - `/subscribe`: read `channel` + `token` from the query, `verifyChannelToken`,
     then forward to `ns.idFromName(channel)` (sharding).
   - `/publish`: read the body **once** as text, `parsePublishBody(JSON.parse(text))`
     for the channel (`400` on malformed), read `token` from `Authorization`/`?token=`,
     `verifyChannelToken`, then forward a **reconstructed** request carrying the
     already-read body (`new Request(url, { method, headers, body: text })`) to
     `ns.idFromName(channel)`. (The original body stream is consumed by the read.)
   - `GET /`: mints a short-lived subscribe **and** publish token for channel `demo`
     with `mintChannelToken(…, env.PUBSUB_SECRET)` and injects them into `DEMO_HTML`
     — modelling "the server that renders your page is the token issuer". No open
     mint endpoint. `GET /` becomes `async`.
6. `serve.ts` — read `PUBSUB_SECRET` from env (with a loud dev-default warning if
   unset) and pass it to `buildFanoutServer`.
7. `test/pubsub.test.ts` — add: missing token → `401`; wrong-mode token → `401`;
   valid token → forwarded/delivered. (Sharding itself is only *observable* on the
   edge — Node is one process — so its proof is the edge smoke, item below.)
8. `test/serve.smoke.test.ts` + `alchemy.run.ts`'s `verifyLive` — mint tokens with
   the shared `PUBSUB_SECRET` (both run under `bun`/CI with the env var) and present
   them on the WS URL + publish header. The smoke keeps proving receipt; it now also
   proves the authz path admits a valid token and that `subscribe?channel=smoke` +
   `publish {channel:smoke}` still rendezvous under `idFromName("smoke")` (sharding).
9. `README.md` — replace the "No authz" caveat with the token model; keep it honest
   that the demo collapses issuer + verifier into one Worker for pedagogy.
10. `.github/workflows/deploy-examples.yml` — add the `PUBSUB_SECRET` secret to the
    `example-pubsub` deploy step (the step already exists, line ~122).

*Note:* Task A does NOT touch `fanout.ts`/`FanoutRoom`, so it composes cleanly with
the reshape landing later.

### Task B — WebSocket hibernation + the reshape (the pivot)
1. `packages/pubsub/src/fanout.ts` — perform reshape **R**: add `fanout()` +
   `FanoutResult` + `bufferedAmount?` on `FanoutSocket` + `FanoutRegistry`; retire
   `FanoutRoom`; remove the in-core seq. Update exports.
2. `packages/pubsub/test/fanout.test.ts` — rewrite against `fanout()` +
   `FanoutRegistry`: fan-out to N sockets; channel isolation; drop-thunk;
   **throwing socket dropped, later sockets still receive, returned in `failed`**
   (invariant 1); `delivered` counts successes only (invariant 3); `FanoutRegistry`
   add/drop/`subscriberCount`. Still 100%, no new exclusion.
3. `examples/pubsub/room.ts` — rewrite the DO to hibernate:
   `#subscribe` → `new WebSocketPair()`, `state.acceptWebSocket(server, [channel])`
   **before** the `101` (invariant 2), `server.serializeAttachment({ channel })`;
   `#publish` → read the durable seq from `state.storage`, `++`, persist, then
   `fanout(state.getWebSockets(channel), { type:"message", channel, seq, data })`;
   `webSocketMessage` no-op (subscribers never publish over WS); `webSocketClose` /
   `webSocketError` → `ws.close()` (runtime evicts from the tag set). Constructor now
   takes `state` (kept). `getWebSockets`/`acceptWebSocket` typed locally like
   `WebSocketPair` (the DOM-lib lesson).
4. `examples/pubsub/src/app.ts` + `serve.ts` — swap `FanoutRoom` for
   `FanoutRegistry` + an in-process `let seq`; `open` → `registry.add`; publish →
   `fanout(registry.socketsFor(channel), frame)` then `registry.drop` each `failed`.
5. Keep Task A's authz + sharding behavior intact (the DO is now per-channel, so
   `getWebSockets(channel)` and the tag are harmlessly redundant but keep item 1
   correct if sharding is ever reverted).
6. README caveat: hibernation shipped; note the DO now costs nothing idle.

Dependency: **Task B blocked-by nothing hard, but should land AFTER Task A** (both
touch `worker.ts`/`room.ts`; sequencing them avoids a merge collision and lets B
assume sharding).

### Task C — ReplayRing + `?since=` resume
Blocked-by **Task B** (needs the hibernating DO shape + the durable seq).
1. `examples/pubsub/room.ts` — a `state.storage` sqlite ring, **one SQL statement
   per `db.exec()`** ([[d1-single-statement-exec-trap]] — multi-statement DDL throws
   7500 on remote DO-sqlite). ⚠️ Key on **`PRIMARY KEY (channel, seq)`**, NOT a bare
   `seq`: `seq` is per-channel (`seq:<channel>`), so a bare-`seq` PK collides across
   channels the moment one DO serves more than one (a publish 500 + cross-channel leak) —
   as shipped in `0269030` and warned in `room.ts`. So: `CREATE TABLE IF NOT EXISTS ring
   (channel TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL,
   PRIMARY KEY (channel, seq))` (one exec); `INSERT …` per publish (one exec); `DELETE
   FROM ring WHERE channel = ? AND seq <= ?` (count bound) and `… WHERE channel = ? AND
   at < ?` (age bound) — separate, channel-scoped execs; `SELECT … WHERE channel = ? AND
   seq > ? ORDER BY seq` for replay (one exec). `/subscribe?...&since=<seq>` replays
   matching rows via `server.send(encodeFrame(...))` **before** live frames.
2. **Ordering + the replay/live race:** capture `sinceSeq` at accept; replay rows
   `seq > sinceSeq`; a publish interleaving replay may double-send a seq → the client
   **dedups by monotonic seq** (ignore `seq <= lastSeen`). Document this floor (it is
   `@lesto/realtime`'s "resync is always correct" philosophy applied to general
   messages). Below the retained window (`since < oldest retained`) the client
   reconnects fresh.
3. Pure ring bound/eviction logic (count + age) can live in a small covered helper in
   `@lesto/pubsub` if it earns its keep; otherwise keep it example-local (SQL does the
   work). Prefer a covered helper for the eviction arithmetic (mirrors realtime).
4. `serializeAttachment({ channel, sinceSeq })` so a woken socket can resume.
5. Smoke: publish → disconnect → reconnect `?since=<seq>` → assert the missed nonce
   replays.

### Task D — Backpressure
Soft-blocked-by **Task B** (cleanest built into `fanout()`).
1. `packages/pubsub/src/fanout.ts` — `fanout(..., { maxBufferedBytes })`: for each
   socket, if `bufferedAmount !== undefined && bufferedAmount > maxBufferedBytes`,
   skip the send and push to `failed` (a slow consumer). Covered with a fake exposing
   `bufferedAmount`.
2. `examples/pubsub/room.ts` — pass `maxBufferedBytes`; for each `failed` socket,
   `ws.close(1013 /* "try again later" */ , "slow-consumer")` so the client
   reconnects (and, with Task C, resumes via `?since=`). This is realtime's
   drop-to-resync policy for a socket transport.
3. Node `app.ts` — pass `maxBufferedBytes`; Bun's `ServerWebSocket` exposes a buffered
   amount too; where it is `undefined`, the bound is simply not enforced (honest).
4. README caveat updated: bounded outbound, close-with-`1013` on overflow.

Order: **A** (now) → **B** → **C** and **D** (parallel, both after B).

## Honest claims (what each graduation will and will not prove)
- ✅ **Authz (A):** a real WS subscriber is admitted only with a valid, scoped,
  unexpired token, machine-checked live on CF; a wrong-mode / wrong-channel / expired
  token is refused with `401` before the DO is touched.
- ✅ **Sharding (A):** channel `X`'s subscribers and publishers rendezvous at
  `idFromName(X)`; the cross-isolate proof survives, now per channel.
- ✅ **Hibernation (B):** the DO fans out from `getWebSockets(channel)` after eviction
  and costs nothing idle; seq is durable.
- ✅ **Resume (C):** a client that reconnects with `?since=<seq>` receives the
  messages it missed, deduped by seq.
- ✅ **Backpressure (D):** a socket over the buffer bound is closed with `1013`, never
  buffered without bound.
- ✋ **Caveats that remain:** the demo still collapses the token *issuer* and
  *verifier* into one Worker (production splits them — the issuer is the app's
  authenticated backend); the ReplayRing is per-channel-DO and bounded (not a durable
  log); ordering across a reconnect rests on client-side seq dedup, not exactly-once
  delivery.

## Risks (verified)
- **`crypto.subtle` in vitest:** the token module is 100%-coverable — Node ≥ 20 (the
  repo runs Node 22) exposes `globalThis.crypto.subtle`; no polyfill, no dep, no
  exclusion. Precedent: `packages/storage/src/sigv4.ts` is unit-tested over it.
- **Body re-read for `/publish` sharding:** a `Request` body is single-read; the
  Worker must read text once and forward a reconstructed request. Verified in the
  reshaped `worker.ts` spec above; the DO re-parses (cheap, correct).
- **Token in the WS query string:** unavoidable (browsers cannot set upgrade
  headers). Mitigated by short `exp` + single-`(channel, mode)` scope — a capability,
  not a credential. Documented.
- **Hibernation seq durability:** an in-memory seq rewinds on eviction and would
  silently corrupt any `?since=` resume — hence the durable seq is folded into Task B,
  not deferred. This is the subtle correctness edge the demo doc flagged.
- **DO-sqlite multi-statement DDL:** the ReplayRing installer MUST issue one statement
  per `db.exec()` — multi-statement DDL passes locally (openSqlite) but throws 7500 on
  remote DO-sqlite ([[d1-single-statement-exec-trap]]). Called out in Task C.
- **`bufferedAmount` availability:** workerd's server `WebSocket` exposes it (no drain
  event, hence poll-at-send); Bun may not — the seam makes it optional (`undefined` ⇒
  unenforced), so neither substrate breaks. Confirm workerd's `bufferedAmount` on the
  live socket in the Task D smoke rather than trusting the type.
- **No new vitest exclusion anywhere:** every new package file (`channel-token.ts`,
  reshaped `fanout.ts`) is pure and fake-driven; the workerd-only wiring
  (`room.ts` hibernation, `getWebSockets`, `acceptWebSocket`, sqlite) stays
  example-local and coverage-exempt, exactly as demo decisions B + G require.
</content>
</invoke>
