---
title: "Pub/sub"
description: "@lesto/pubsub is dependency-free publish/subscribe: an in-process hub with ordered, awaited delivery, plus a transport-neutral WebSocket fan-out core — send policy with backpressure, and signed per-channel capability tokens."
section: Batteries
order: 14
---

# Pub/sub

`@lesto/pubsub` decouples the code that emits an event from the code that reacts
to it. It ships two dependency-free layers: an in-process `PubSub` hub — one side
calls `publish(channel, message)`, every listener registered with
`subscribe(channel, listener)` receives it — and a transport-neutral core for
[fanning a channel out over real WebSockets](#fan-out-over-websockets), with
signed per-channel capability tokens for authorization.

The hub's design rests on one property: delivery is **in subscription order, and
`publish` resolves only after every listener — sync and async — has settled**.
Its state lives in process memory, so the hub is for fan-out within one worker;
the fan-out core is the cross-process building block.

## Create a hub and subscribe

Construct a `PubSub` and call `subscribe` with a channel name and a listener.
Each listener receives the published `message` and the `channel` it arrived on.
`subscribe` returns an unsubscribe function — call it to remove exactly that
listener:

```ts
import { PubSub } from "@lesto/pubsub";

const hub = new PubSub();

const off = hub.subscribe("orders", (message, channel) => {
  console.log(`${channel}:`, message);
});

await hub.publish("orders", { id: 1 }); // logs "orders: { id: 1 }"

off(); // this listener stops receiving
```

The `message` is typed `unknown` — the hub doesn't know or constrain your
payload shape, so narrow it inside the listener (or wrap the hub in your own
typed helper). Registration is synchronous: a listener added before a `publish`
is guaranteed to see that publish.

## Publish and await delivery

`publish` returns a `Promise<number>` — the count of listeners notified. It
delivers to each subscriber in subscription order and **awaits** any listener
that returns a promise before moving to the next one, so the returned promise
resolves only once the whole chain has finished:

```ts
hub.subscribe("orders", async (message) => {
  await recordToLedger(message); // publish() waits for this
});

const notified = await hub.publish("orders", { id: 7 });
// notified === number of listeners that ran
```

Publishing to a channel with no subscribers returns `0` and does nothing else —
it's a safe no-op, not an error. Because delivery is sequential and awaited,
ordering between listeners is deterministic and a slow async listener delays the
ones after it; this is a serial hub, not a parallel dispatcher.

## The `Listener` type

A listener is `(message, channel) => void | Promise<void>`. The package exports
this as the `Listener` type so you can name handlers declared apart from the
`subscribe` call:

```ts
import { PubSub, type Listener } from "@lesto/pubsub";

const onOrder: Listener = async (message, channel) => {
  await fulfil(message);
};

const hub = new PubSub();
hub.subscribe("orders", onOrder);
```

Listener identity is what `subscribe`, `unsubscribe`, and the returned
unsubscribe function key on — so a named handler is also what lets you remove a
listener later without holding the returned function.

## Unsubscribe and inspect

There are two ways to remove a listener: call the function `subscribe` returned,
or call `hub.unsubscribe(channel, listener)` with the same listener reference.
Both are safe to call when the listener isn't registered, and the returned
unsubscribe is idempotent — calling it twice is harmless:

```ts
const off = hub.subscribe("orders", onOrder);

off();                            // removes onOrder
hub.unsubscribe("orders", onOrder); // already gone — no-op

hub.subscriberCount("orders"); // 0
hub.clear("orders");           // drop one channel's listeners
hub.clear();                   // drop every channel
```

`subscriberCount(channel)` reports how many listeners a channel currently has
(`0` for an unknown channel), and `clear` drops listeners for one named channel,
or for every channel when called with no argument — handy for resetting a hub
between tests or on teardown.

## Fan out over WebSockets

The hub stops at the process boundary. For a live, cross-process feed — a
browser subscribing to a channel over a WebSocket — the package ships the
transport-neutral core, and [`examples/pubsub`](https://github.com/lesto-run/lesto/tree/main/examples/pubsub)
wires it to two real substrates: a single Bun process, and a
WebSocket-terminating Cloudflare Durable Object.

`fanout(sockets, frame, options?)` is the pure send policy: encode the frame
once, write it to every socket, and never let a dead socket abort delivery to
the rest. It returns `{ delivered, failed }` — a failed socket (a `send` that
threw, or a slow consumer whose `bufferedAmount` exceeds `maxBufferedBytes`) is
skipped and handed back for you to close. `FanoutRegistry` is the in-memory
channel → sockets map for a single-process server; a hibernatable Durable Object
skips it, because workerd's `state.getWebSockets(tag)` *is* the registry there.

```ts
import { FanoutRegistry, fanout, parsePublishBody } from "@lesto/pubsub";

const registry = new FanoutRegistry();
const drop = registry.add("orders", socket); // call from the socket's close handler

const body = parsePublishBody(await request.json()); // undefined → answer 400
if (body !== undefined) {
  const { delivered, failed } = fanout(
    registry.socketsFor(body.channel),
    { type: "message", channel: body.channel, seq: nextSeq(), data: body.message },
    { maxBufferedBytes: 1024 * 1024 },
  );

  for (const slow of failed) registry.drop(body.channel, slow); // then close it
}
```

You stamp the monotonic `seq` yourself: a single process keeps it in a variable,
a Durable Object keeps it durable — an in-memory counter would rewind when the
runtime evicts the isolate.

### Channel capability tokens

Without authorization, anyone who can reach `/subscribe` or `/publish` can read
or write any channel. A browser can't set headers on a WebSocket upgrade, so the
answer rides the URL — as a **scoped capability**, not a shared secret. Your
authenticated backend mints a short-lived token for exactly one
`(channel, mode)`; the edge only ever verifies:

```ts
import { mintChannelToken, verifyChannelToken } from "@lesto/pubsub";

// Server-side (holds the secret): grant one channel, one mode, for one minute.
const token = await mintChannelToken(
  { channel: "org:42", mode: "subscribe", exp: Date.now() + 60_000 },
  env.PUBSUB_SECRET,
);

// At the edge, before upgrading or publishing:
const result = await verifyChannelToken(
  token,
  { channel: "org:42", mode: "subscribe" },
  env.PUBSUB_SECRET,
);

if (!result.ok) return new Response("unauthorized", { status: 401 });
```

Tokens are HMAC-SHA256 over `crypto.subtle` — no `node:crypto`, no
`nodejs_compat` flag — and verification never throws: a malformed, forged,
expired, or mis-scoped token is a tagged failure whose `reason` is one of
`"malformed"`, `"bad-signature"`, `"expired"`, `"wrong-channel"`, or
`"wrong-mode"`, so the caller answers 401 instead of 500. A leaked token grants
one channel, one mode, for a short window — never the keys to the bus.

### The runnable demo

`examples/pubsub` runs the same protocol on both substrates: `serve.ts` is the
single-process Bun server (one `FanoutRegistry`, one in-process `seq`), and
`room.ts` is a hibernatable Cloudflare Durable Object that terminates the
WebSockets — one DO per channel, a durable `seq`, and a bounded replay ring
behind `?since=<seq>` whose eviction arithmetic is the exported
`replayEvictionBounds`. Both verify the same tokens and share the same `fanout`
policy, so semantics are identical from local dev to the edge.

## Notes and gotchas

- **The `PubSub` hub is in-process only.** Its state is plain process memory in
  one instance. It does not span workers, requests, or machines, and nothing is
  persisted — a restart starts empty. For cross-process delivery over
  WebSockets, use [the fan-out core](#fan-out-over-websockets); for durable,
  retried work, reach for [the queue](/batteries/queue).
- **`publish` is serial and awaited.** Listeners run one after another in
  subscription order, and each async listener is awaited before the next starts.
  A slow or hanging listener holds up the rest and delays the `publish` promise.
  If you need fire-and-forget, don't `await` the `publish` — but then you give up
  knowing delivery finished.
- **Errors propagate.** A listener that throws (or rejects) surfaces out of the
  `await publish(...)` and stops the remaining listeners in that delivery — there
  is no built-in try/catch around each listener. Guard inside listeners you don't
  want to be able to break a publish.
- **Identity-based, and deduped.** A channel's listeners are held in a `Set`, so
  subscribing the *same function reference* twice to one channel registers it
  once. Two different functions with identical bodies are two listeners. Keep a
  stable reference if you intend to unsubscribe later.
- **`message` is `unknown`.** The hub doesn't validate or type payloads. Narrow
  the value inside the listener, and validate untrusted input at the boundary —
  see [Validation](/guides/validation) — before you publish it.
- **Mid-publish changes don't affect the in-flight delivery.** `publish`
  snapshots the listener list up front, so a listener that subscribes or
  unsubscribes during delivery changes only *future* publishes, not the one
  currently running.

For the broader picture of how the batteries fit together, see
[Concepts](/concepts); for durable, cross-process work, see
[the queue](/batteries/queue).
