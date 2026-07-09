# examples/pubsub — live fan-out over WebSockets

Wires **`@lesto/pubsub`** behind real WebSockets so you can see the one thing that
only shows up end-to-end: a message published by **one** connection reaching a
socket opened by **another**. A subscriber opens a WebSocket to a channel; a
separate HTTP request publishes to that channel; every subscriber receives one
framed copy.

On Node a single process is the coordination point (an in-memory `FanoutRegistry`).
On Cloudflare there is no shared memory across isolates, so the same fan-out needs
one coordination point — a **hibernatable Durable Object**. This is the first
WebSocket-terminating DO substrate in the framework, and it runs the SAME transport-
neutral send policy (`fanout()`, in `@lesto/pubsub`) as the Node path.

## What it shows

| Route                                                              | Behavior                                                                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET  /subscribe?channel=<name>&token=<t>[&since=<seq>]`           | Verifies a `subscribe`-mode token for `<name>` (else `401`), then upgrades to a WebSocket subscribed to `<name>`; receives one framed message per publish. `?since=<seq>` (**edge only** — the Node twin ignores it) first replays every retained message newer than `<seq>` from the durable ring (missed-message resume). |
| `POST /publish` `{channel, message}` + `Authorization: Bearer <t>` | Verifies a `publish`-mode token for the channel (else `401`), then fans `message` out; returns `{ delivered }` (see the caveat).                           |
| `GET  /` (edge only)                                               | The token issuer: mints short-lived `demo`-channel subscribe + publish tokens and serves a tiny browser demo that uses them.                               |

The fan-out core is `@lesto/pubsub`'s public API — `fanout()`, `FanoutRegistry`,
`parsePublishBody`, `encodeFrame` — and its authz core is `mintChannelToken` /
`verifyChannelToken` (a signed per-channel capability token over Web Crypto).
Everything else is thin plumbing: Bun's native WebSocket server on Node (`serve.ts`
/ `src/app.ts`), a Durable Object on the edge (`room.ts` + `worker.ts`).

`delivered` is the number of subscribers the message was **successfully written to**
— a diagnostic, not a delivery receipt. A socket that dies mid-send is excluded from
`delivered` (returned in `fanout`'s `failed` and reaped), so the tests assert
**receipt on the socket**, never `delivered` alone.

## How it's tested (the QA gate)

```bash
bun run --filter '@lesto/example-pubsub' test
```

- `test/pubsub.test.ts` drives `src/app.ts` in-process with fake sockets: fan-out
  to every subscriber, channel isolation, a closed subscriber stops receiving,
  malformed `/publish` bodies are 400, the authz guard (missing / wrong-mode /
  wrong-channel tokens are 401; a valid token is admitted), upgrade handoff, routing.
- `test/serve.smoke.test.ts` boots `serve.ts` under Bun on an ephemeral port, opens a
  **real** token-authenticated WebSocket, publishes a random nonce over a **separate**
  HTTP request, and asserts the subscriber receives it — then SIGTERMs and checks a
  clean exit.

The package cores (`fanout()` / `FanoutRegistry` + the `channel-token` mint/verify) are
unit-tested to 100% inside `@lesto/pubsub`, including the throwing-socket and tampered-token
invariants.

> The Node app (`src/app.ts`) is covered above; **`worker.ts` — the edge authz +
> per-channel-routing boundary — is exercised only by the live-CF deploy smoke**
> (`alchemy.run.ts`), which proves the happy path + a tokenless-`401`. In-process
> coverage of `worker.ts` is a tracked follow-up (see the design doc).

## Run it locally

```bash
# serve.ts + mint.ts fail CLOSED on a missing secret; opt into the insecure dev key:
PUBSUB_ALLOW_INSECURE=1 bun run examples/pubsub/serve.ts
```

Bun's `serve` carries a native WebSocket server (no `ws` dependency; the same
primitive `lesto dev`'s live-reload uses). One process means one `FanoutRegistry`
for every connection — this single node is the coordination point the edge needs a
DO for. Both routes require a signed capability token; `mint.ts` is the local issuer.
Drive it:

```bash
# mint the two capability tokens (subscribe token valid 1h locally) — the edge
# does this on GET /. The dev key requires the explicit insecure opt-in:
SUB=$(PUBSUB_ALLOW_INSECURE=1 bun mint.ts news subscribe)
PUB=$(PUBSUB_ALLOW_INSECURE=1 bun mint.ts news publish)

# terminal 1 — subscribe (wscat, or any WS client):
wscat -c "ws://127.0.0.1:3000/subscribe?channel=news&token=$SUB"
# terminal 2 — publish; the subscriber above receives it:
curl -X POST 127.0.0.1:3000/publish -H 'content-type: application/json' \
  -H "authorization: Bearer $PUB" \
  -d '{"channel":"news","message":"hello"}'
```

Set `PUBSUB_SECRET` (instead of `PUBSUB_ALLOW_INSECURE=1`) on both `serve.ts` and
`mint.ts` to use a real key — they share `secret.ts`, so the two never drift.

## Deploy to Cloudflare (the edge leg) — LIVE

```bash
bun run examples/pubsub/deploy   # bun alchemy.run.ts
```

`worker.ts` runs the same fan-out on the edge, but the coordination point is a
**hibernatable Durable Object** (`room.ts`), and the Worker is the **authz
boundary**: it verifies the capability token before forwarding, so an unauthorized
caller is `401`ed before the DO is touched. Routing is **per channel** —
`/subscribe` and `/publish` for channel `X` are both routed to `idFromName(X)`, so a
subscriber and a publisher that land on different isolates still rendezvous at the
same DO (the cross-isolate proof), while different channels get different DOs. The DO
holds no in-memory hub: it hands each subscriber socket to
`state.acceptWebSocket(server, [channel])` (**before** returning the `101`, so no
publish can race a subscribe) and fans out over `state.getWebSockets(channel)`, so an
idle room costs nothing and survives eviction. `GET /` is the token issuer — it mints
the demo page's tokens with `PUBSUB_SECRET`.

`alchemy.run.ts` (ADR 0044 — Alchemy IaC, no `wrangler.toml`) declares the Worker,
its DO namespace, and the `PUBSUB_SECRET` binding, and after `finalize()` runs two
**post-deploy smokes**. The first opens a real WebSocket to the live url (with a minted
subscribe token), publishes a fresh random nonce over a separate HTTP request (with a
publish token), and asserts the subscriber receives it. The second proves
**missed-message resume**: a subscriber records a live message's seq, disconnects, a
second message is published while it is offline, and a fresh connection with
`?since=<seq>` receives that missed message — which (published before the second connect)
can only have come from the durable ring. CI runs exactly this on every push to main
(`.github/workflows/deploy-examples.yml`), so "it deploys AND authorized fan-out + resume
work on the edge" is machine-checked, not a manual click-through.

**Honest claim:** a genuinely live Cloudflare deploy with a behavioral proof — a real
WS subscriber (admitted with a valid scoped token) receives a message published by a
separate authorized request through the Durable Object; a subscriber that reconnects
with `?since=<seq>` catches up on a message published while it was offline (from the
durable ring); **and** a tokenless publish is refused with `401`: a true
cross-connection, DO-mediated, authenticated fan-out with missed-message resume, no
manual hop. What the edge smokes do **not** cover: (1) the reject matrix `wrong-mode` /
`wrong-channel` — proven against the Node twin (`src/app.ts`), a separate implementation
of the same guard; `expired`-rejection is proven a layer down in the `channel-token` unit
suite, and `GET /` minting is exercised only by this smoke's happy path (there is no
`GET /` in the Node twin); (2) **hibernation itself** — both smokes act within seconds on
a _warm_ DO, so they prove cross-connection fan-out and ring-backed resume but never force
an eviction, i.e. they do not machine-check that fan-out or the durable `seq`/ring survive
a cold wake; and (3) the **backpressure overflow-close** on the edge — the `1013` close is
proven on the Node substrate + in the pure-core unit tests, but is by-construction-only on
workerd (overflowing a real socket's queue over a fast network isn't deterministically
forcible). The DO's handshake is correct by construction (reviewed against the workerd
API); a real eviction/backpressure test (via `vitest-pool-workers`) and broader
`worker.ts`/`room.ts` coverage are tracked follow-ups
(`docs/plans/pubsub-production-substrate.md`).

## Authz (the capability-token model)

Both routes require a signed, per-channel, per-mode, short-lived **capability
token** (`@lesto/pubsub`'s `mintChannelToken` / `verifyChannelToken` — HMAC-SHA256
over Web Crypto, dependency-free, no `nodejs_compat`). The wire format is
`base64url(JSON({channel, mode, exp})) + "." + base64url(HMAC(payload, secret))`. A
subscribe token cannot publish; a token for one channel cannot touch another; an
expired token is refused — a leaked token is a scoped, short-lived capability, not
a master credential. The token rides the WS upgrade URL (a browser cannot set
upgrade headers) or the publish `Authorization: Bearer` header; the Worker (and the
Node app) verify it BEFORE forwarding.

**Honest simplification:** the demo collapses the token _issuer_ and _verifier_ into
one Worker (`GET /` mints; the same Worker verifies). Production splits them — the
issuer is your app's authenticated backend (which already holds the session and
decides _who may subscribe to what_), signing with a secret the edge only verifies.

## Caveats (what a production substrate would still add)

This proves authenticated, per-channel, **hibernatable** fan-out — not yet a full
production message bus. Remaining simplifications, each with its graduation path
(tracked as follow-up tasks; see `docs/plans/pubsub-production-substrate.md`):

- ✅ **WebSocket hibernation — shipped.** The DO holds no in-memory hub: every
  subscriber socket is handed to `state.acceptWebSocket(server, [channel])` (tagged
  with its channel), and each publish fans out over `state.getWebSockets(channel)` —
  so an idle room costs nothing and survives eviction. The per-channel `seq` lives in
  `state.storage` (durable), never rewinding on eviction. Per-channel sharding
  (`idFromName(channel)`) shipped in Task A.
- ✅ **Missed-message resume — shipped (server side).** Every publish is appended to a
  bounded per-channel `state.storage` sqlite ring keyed `(channel, seq)`; a subscriber
  that reconnects with `?since=<seq>` is replayed every retained row `seq > since` BEFORE
  any live frame, so a briefly-disconnected client catches up. The ring is bounded by
  BOTH count and age (its eviction arithmetic is `@lesto/pubsub`'s pure, 100%-covered
  `replayEvictionBounds`). Because a live publish can interleave a replay, a **correct
  client MUST dedup by monotonic seq** (ignore `seq <= lastSeen`) — the app owns this
  contract; the browser demo does not implement it. Below the retained window the missed
  rows are gone for good (this is a bounded buffer, not a durable log) and the server
  sends **no** gap/resync marker, so a client that must not miss a message has to detect
  the hole itself (its first replayed `seq > since + 1`) and recover. The durable
  per-channel `seq` (Task B) is the sole owner of the counter — the ring is a bounded
  copy, never the source, so an evicted ring can never rewind the seq a resume trusts.
- ✅ **Bounded outbound — shipped.** `fanout(..., { maxBufferedBytes })` polls each
  socket's `bufferedAmount` at send time; a slow consumer over the bound (1 MiB here) is
  never buffered without limit — it is skipped, returned in `failed`, and **closed with
  `1013`** ("try again later"), so the client reconnects and (on the edge, with the ring)
  resumes via `?since=`. This is `@lesto/realtime`'s drop-to-resync applied to a socket
  transport. workerd exposes `bufferedAmount` as a property, Bun's `ServerWebSocket` via
  `getBufferedAmount()`; a transport that reports neither leaves the bound unenforced
  (honest — nothing to measure). The policy is unit-tested to 100% in `@lesto/pubsub` and
  proven behaviorally on the Node substrate (a slow fake is closed with `1013` + dropped).
  It is **not** in the edge deploy smoke: deterministically overflowing a real socket's
  outbound queue over a fast network isn't feasible — a `vitest-pool-workers` test is the
  tracked way to machine-check the bound live (see `docs/plans/pubsub-production-substrate.md`).
