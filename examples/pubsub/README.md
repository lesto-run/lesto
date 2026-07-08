# examples/pubsub — live fan-out over WebSockets

Wires **`@lesto/pubsub`** behind real WebSockets so you can see the one thing that
only shows up end-to-end: a message published by **one** connection reaching a
socket opened by **another**. A subscriber opens a WebSocket to a channel; a
separate HTTP request publishes to that channel; every subscriber receives one
framed copy.

`@lesto/pubsub`'s `PubSub` is an in-process hub, so on Node a single process is
the coordination point. On Cloudflare there is no shared memory across isolates,
so the same fan-out needs one coordination point — a **Durable Object**. This is
the first WebSocket-terminating DO substrate in the framework, and it runs the SAME transport-neutral
core (`FanoutRoom`, in `@lesto/pubsub`) as the Node path.

## What it shows

| Route                                                              | Behavior                                                                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET  /subscribe?channel=<name>&token=<t>`                         | Verifies a `subscribe`-mode token for `<name>` (else `401`), then upgrades to a WebSocket subscribed to `<name>`; receives one framed message per publish. |
| `POST /publish` `{channel, message}` + `Authorization: Bearer <t>` | Verifies a `publish`-mode token for the channel (else `401`), then fans `message` out; returns `{ delivered }` (see the caveat).                           |
| `GET  /` (edge only)                                               | The token issuer: mints short-lived `demo`-channel subscribe + publish tokens and serves a tiny browser demo that uses them.                               |

The fan-out core is `@lesto/pubsub`'s public API — `FanoutRoom`, `parsePublishBody`,
`encodeFrame` — and its authz core is `mintChannelToken` / `verifyChannelToken` (a
signed per-channel capability token over Web Crypto). Everything else is thin
plumbing: Bun's native WebSocket server on Node (`serve.ts` / `src/app.ts`), a
Durable Object on the edge (`room.ts` + `worker.ts`).

`delivered` is the number of subscribers the message was **dispatched** to at
publish time — a diagnostic, not a delivery receipt. A socket that dies mid-send
is dropped but still counted for that one call, so the tests assert **receipt on
the socket**, never `delivered` alone.

## How it's tested (the QA gate)

```bash
bun run --filter '@lesto/example-pubsub' test
```

- `test/pubsub.test.ts` drives `src/app.ts` in-process with fake sockets: fan-out
  to every subscriber, channel isolation, a closed subscriber stops receiving,
  malformed `/publish` bodies are 400, upgrade handoff and routing.
- `test/serve.smoke.test.ts` boots `serve.ts` under Bun on an ephemeral port,
  opens a **real** WebSocket, publishes a random nonce over a **separate** HTTP
  request, and asserts the subscriber receives it — then SIGTERMs and checks a
  clean exit.

The package core (`FanoutRoom`) is unit-tested to 100% inside `@lesto/pubsub`
(`packages/pubsub/test/fanout.test.ts`), including the throwing-socket invariant.

## Run it locally

```bash
bun run examples/pubsub/serve.ts
```

Bun's `serve` carries a native WebSocket server (no `ws` dependency; the same
primitive `lesto dev`'s live-reload uses). One process means one `FanoutRoom` for
every connection — this single node is the coordination point the edge needs a DO
for. Both routes require a signed capability token; `mint.ts` is the local issuer
(it uses the same insecure dev secret `serve.ts` falls back to). Drive it:

```bash
# mint the two capability tokens (valid 1h) — the edge does this on GET /:
SUB=$(bun mint.ts news subscribe)
PUB=$(bun mint.ts news publish)

# terminal 1 — subscribe (wscat, or any WS client):
wscat -c "ws://127.0.0.1:3000/subscribe?channel=news&token=$SUB"
# terminal 2 — publish; the subscriber above receives it:
curl -X POST 127.0.0.1:3000/publish -H 'content-type: application/json' \
  -H "authorization: Bearer $PUB" \
  -d '{"channel":"news","message":"hello"}'
```

Set `PUBSUB_SECRET` on both `serve.ts` and `mint.ts` to use a real key instead of
the dev default.

## Deploy to Cloudflare (the edge leg) — LIVE

```bash
bun run examples/pubsub/deploy   # bun alchemy.run.ts
```

`worker.ts` runs the same fan-out on the edge, but the hub lives in a **Durable
Object** (`room.ts`) instead of process memory, and the Worker is the **authz
boundary**: it verifies the capability token before forwarding, so an unauthorized
caller is `401`ed before the DO is touched. Routing is **per channel** —
`/subscribe` and `/publish` for channel `X` are both routed to `idFromName(X)`, so a
subscriber and a publisher that land on different isolates still rendezvous at the
same in-memory `FanoutRoom` (the cross-isolate proof), while different channels get
different DOs. The DO terminates the WebSocket itself and registers the socket
**before** returning the `101`, so no publish can race a subscribe. `GET /` is the
token issuer — it mints the demo page's tokens with `PUBSUB_SECRET`.

`alchemy.run.ts` (ADR 0044 — Alchemy IaC, no `wrangler.toml`) declares the Worker,
its DO namespace, and the `PUBSUB_SECRET` binding, and after `finalize()` runs a
**post-deploy smoke**: it opens a real WebSocket to the live url (with a minted
subscribe token), publishes a fresh random nonce over a separate HTTP request (with
a publish token), and asserts the subscriber receives it. CI runs exactly this on
every push to main (`.github/workflows/deploy-examples.yml`), so "it deploys AND
authorized fan-out works on the edge" is machine-checked, not a manual click-through.

**Honest claim:** a genuinely live Cloudflare deploy with a behavioral proof — a
real WS subscriber, admitted only with a valid scoped token, receives a message
published by a separate authorized request through the Durable Object: a true
cross-connection, DO-mediated, authenticated fan-out. There is no manual hop.

## Authz (the capability-token model)

Both routes require a signed, per-channel, per-mode, short-lived **capability
token** (`@lesto/pubsub`'s `mintChannelToken` / `verifyChannelToken` — HMAC-SHA256
over Web Crypto, dependency-free, no `nodejs_compat`). The wire format is
`base64url(JSON({channel, mode, exp})) + "." + base64url(HMAC(payload, secret))`. A
subscribe token cannot publish; a token for one channel cannot touch another; an
expired token is refused — a leaked token is a scoped, seconds-long capability, not
a master credential. The token rides the WS upgrade URL (a browser cannot set
upgrade headers) or the publish `Authorization: Bearer` header; the Worker (and the
Node app) verify it BEFORE forwarding.

**Honest simplification:** the demo collapses the token _issuer_ and _verifier_ into
one Worker (`GET /` mints; the same Worker verifies). Production splits them — the
issuer is your app's authenticated backend (which already holds the session and
decides _who may subscribe to what_), signing with a secret the edge only verifies.

## Caveats (what a production substrate would still add)

This proves authenticated, per-channel fan-out — not yet a full production message
bus. Remaining simplifications, each with its graduation path (tracked as follow-up
tasks; see `docs/plans/pubsub-production-substrate.md`):

- **Non-hibernating DO.** The DO keeps a live in-memory `FanoutRoom`, so it bills
  wall-clock while any socket is open and loses its hub on eviction. **WebSocket
  hibernation** (`state.acceptWebSocket()` + `state.getWebSockets()` +
  `webSocketMessage/Close/Error` handlers + a durable seq) would make an idle room
  cost nothing. (Per-channel sharding — `idFromName(channel)` — has shipped.)
- **No missed-message resume.** Fan-out is ephemeral in-memory; a subscriber that
  connects after a publish never sees it. A `state.storage`-backed replay ring (the
  `sqlite: true` namespace already declared is the hook) plus `?since=<seq>` would
  let a reconnecting client catch up.
- **Unbounded outbound.** A slow socket's send queue is unbounded (workerd buffers
  `send`); `@lesto/realtime`'s SSE `maxQueue` is the model for backpressure.
