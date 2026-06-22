---
title: "Pub/sub"
description: "@lesto/pubsub is a dependency-free in-process publish/subscribe hub: subscribe listeners to channels, publish messages, and await sequential, ordered delivery to sync and async listeners alike."
section: Batteries
order: 14
---

# Pub/sub

`@lesto/pubsub` is a single, dependency-free `PubSub` class: an in-process
publish/subscribe hub for decoupling the code that emits an event from the code
that reacts to it. One side calls `publish(channel, message)`; any number of
listeners registered with `subscribe(channel, listener)` receive it. The whole
design rests on one property: delivery is **in subscription order, and `publish`
resolves only after every listener — sync and async — has settled**. State lives
in process memory, so this is for in-process fan-out within one worker, not a
cross-process message bus.

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

## Notes and gotchas

- **In-process only.** State is plain process memory in this one `PubSub`
  instance. It does not span workers, requests, or machines, and nothing is
  persisted — a restart starts empty. For cross-process or durable delivery,
  reach for [the queue](/batteries/queue) instead; pub/sub is for fan-out inside
  a single process.
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
