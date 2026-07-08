# examples/pubsub — live fan-out over WebSockets

Wires **`@lesto/pubsub`** behind real WebSockets so you can see the one thing that
only shows up end-to-end: a message published by **one** connection reaching a
socket opened by **another**. A subscriber opens a WebSocket to a channel; a
separate HTTP request publishes to that channel; every subscriber receives one
framed copy.

`@lesto/pubsub`'s `PubSub` is an in-process hub, so on Node a single process is
the coordination point. On Cloudflare there is no shared memory across isolates,
so the same fan-out needs one coordination point — a **Durable Object**. This is
the first DO substrate in the framework, and it runs the SAME transport-neutral
core (`FanoutRoom`, in `@lesto/pubsub`) as the Node path.

## What it shows

| Route                                   | Behavior                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET  /subscribe?channel=<name>`        | Upgrades to a WebSocket subscribed to `<name>`; receives one framed message per publish.    |
| `POST /publish` `{channel, message}`    | Fans `message` out to that channel's subscribers; returns `{ delivered }` (see the caveat). |
| `GET  /` (edge only)                    | A tiny browser demo: subscribes to `#demo` and publishes to it from a button.               |

The fan-out core is `@lesto/pubsub`'s public API — `FanoutRoom`, `parsePublishBody`,
`encodeFrame`. Everything else is thin plumbing: Bun's native WebSocket server on
Node (`serve.ts` / `src/app.ts`), a Durable Object on the edge (`room.ts` +
`worker.ts`).

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
for. Drive it:

```bash
# terminal 1 — subscribe (wscat, or any WS client):
wscat -c "ws://127.0.0.1:3000/subscribe?channel=news"
# terminal 2 — publish; the subscriber above receives it:
curl -X POST 127.0.0.1:3000/publish -H 'content-type: application/json' \
  -d '{"channel":"news","message":"hello"}'
```

## Deploy to Cloudflare (the edge leg) — LIVE

```bash
bun run examples/pubsub/deploy   # bun alchemy.run.ts
```

`worker.ts` runs the same fan-out on the edge, but the hub lives in a **Durable
Object** (`room.ts`) instead of process memory. `/subscribe` and `/publish` are
both routed to ONE named DO instance (`idFromName("hub")`), so a subscriber and a
publisher that land on different isolates still rendezvous at the same in-memory
`FanoutRoom` — the cross-isolate proof. The DO terminates the WebSocket itself and
registers the socket **before** returning the `101`, so no publish can race a
subscribe.

`alchemy.run.ts` (ADR 0044 — Alchemy IaC, no `wrangler.toml`) declares the Worker
+ its DO namespace and, after `finalize()`, runs a **post-deploy smoke**: it opens
a real WebSocket to the live url, publishes a fresh random nonce over a separate
HTTP request, and asserts the subscriber receives it. CI runs exactly this on
every push to main (`.github/workflows/deploy-examples.yml`), so "it deploys AND
fan-out works on the edge" is machine-checked, not a manual click-through.

**Honest claim:** a genuinely live Cloudflare deploy with a behavioral proof — a
real WS subscriber receives a message published by a separate request through the
Durable Object, a true cross-connection, DO-mediated fan-out. There is no manual
hop.

## Caveats (what a production substrate would add)

This is a demo of the fan-out mechanism, not a production message bus. Deliberate
simplifications, each with its graduation path:

- **No authz.** Anyone who can reach `/subscribe` or `/publish` can read or write
  any channel. Authorizing a subscriber/publisher is the app's job (a token on the
  upgrade URL, a check in the Worker before forwarding to the DO).
- **One DO instance per app, non-hibernating.** A single `idFromName("hub")` gives
  an airtight cross-isolate proof but is a throughput ceiling, and a
  non-hibernating DO bills wall-clock while any socket is open. Production would
  shard per channel (`idFromName(channel)`) and use **WebSocket hibernation**
  (`state.getWebSockets()` + `webSocketMessage/Close/Error` handlers) so an idle
  room costs nothing.
- **No missed-message resume.** Fan-out is ephemeral in-memory; a subscriber that
  connects after a publish never sees it, and if every socket closes the DO may
  evict and lose its hub. A `state.storage`-backed replay ring (the `sqlite: true`
  namespace already declared is the hook) would let a reconnecting client catch up.
- **Unbounded outbound.** A slow socket's send queue is unbounded (workerd buffers
  `send`); `@lesto/realtime`'s SSE `maxQueue` is the model for backpressure.
