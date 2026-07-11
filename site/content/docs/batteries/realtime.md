---
title: Realtime
description: "@lesto/realtime pushes invalidation topics — a key string, never row data — over Postgres LISTEN/NOTIFY, fanned out to the browser over SSE. A write publishes a topic; every mounted live query drops that key and refetches through its own authorized read."
section: Batteries
order: 14.5
---

# Realtime

`@lesto/realtime` is the reactive layer: when a write lands, every browser reading
the affected data refetches — no polling, no manual cache-busting. It does that by
pushing an **invalidation topic** — a key string like `room:42`, **never the row
data itself** — over Postgres `LISTEN/NOTIFY`, fanned out to each connected browser
over Server-Sent Events. A mounted live query hears the topic, drops that one cache
key, and refetches through its *own* authorized read.

That last part is the whole security design. The wire carries a **topic, not a
row**, so a push can never leak data a client may not see: there is nothing on the
wire to leak, and the refetch re-runs the app's normal authorized endpoint. It does
**not** stream your data to the browser. If you want the rows *themselves* on a
durable, offline-capable local replica, that is a different product — see
[local-first sync](/batteries/live).

`@lesto/realtime` is the server-side transport and SSE fan-out; the browser binding
(`useLive` + a live `useQuery`) ships in [`@lesto/ui`](/batteries/data). Both halves
are shipped and supported.

## Mount the live stream

`createRealtimeHttpHandlers` builds the SSE handler. Mount its `live` handler at the
reserved path `GET /__lesto/live` — the runtime recognizes it as a long-lived
stream, so the held connection takes no in-flight slot and is never compressed. The
package is generic over your principal type, so it needs no `@lesto/authz`
dependency: you supply `resolvePrincipal` and `authorizeTopic`.

```ts
import { PubSub } from "@lesto/pubsub";
import { ReplayRing, createRealtimeHttpHandlers } from "@lesto/realtime";

const hub = new PubSub();
// `instanceId` is a per-PROCESS id, minted fresh at boot — never a fixed string.
const ring = new ReplayRing({ instanceId: crypto.randomUUID(), maxEntries: 1000, maxAgeMs: 300_000 });

const realtime = createRealtimeHttpHandlers<Principal>({
  hub,
  ring,
  resolvePrincipal: (c) => principalFromSession(c),
  // Authorize ONE topic for the principal — `room:42` is allowed iff this
  // principal may see room 42. An unauthorized topic is DROPPED, not refused.
  authorizeTopic: (principal, topic) => mayAccessRoom(principal, roomOf(topic)),
});

app.get("/__lesto/live", realtime.live);
```

An unauthorized topic is **dropped silently**, not rejected — the connection still
opens for the topics the principal *may* see, and a client never learns a topic it
cannot see even exists (dropping instead of failing closes the change-timing
side-channel). `onDropped` surfaces the drop for logging.

## Publish a topic after a write

A write declares a topic dirty *after* it commits. In a single process you can drive
the ring and hub directly:

```ts
messages.push(message);

const topic = `room:${roomId}`;
void hub.publish(topic, ring.record(topic)); // record assigns the cursor; hub fans it out
```

Across a fleet — many app instances behind a load balancer — publish through a
`RealtimeBus` over the `PostgresTransport`. One dedicated `LISTEN` client per process
(beside the `@lesto/db` pool, never from it) carries topics between nodes:

```ts
import {
  PostgresTransport,
  ReplayRing,
  createPgListenClientFactory,
  createRealtimeBus,
} from "@lesto/realtime";

// Each node mints its OWN id at boot. A shared id across the fleet is a silent bug: two
// nodes would reuse the same (generation, index) cursor space, so a client reconnecting to
// a different node (the norm behind a non-sticky load balancer) presents a cursor the new
// node mistakes for its own position — and replays the wrong frames instead of resyncing.
const ring = new ReplayRing({ instanceId: crypto.randomUUID(), maxEntries: 1000, maxAgeMs: 300_000 });

const bus = createRealtimeBus({
  ring,
  transport: new PostgresTransport({
    createClient: createPgListenClientFactory({ connectionString: process.env.DATABASE_URL }),
    // A re-LISTEN gap means missed NOTIFYs, so a reconnect bumps the generation →
    // stale cursors can no longer prove continuity and are forced to resync.
    bumpGeneration: () => ring.bumpGeneration(),
  }),
});

await bus.start();

// After the write commits — never before:
await bus.publish(`room:${roomId}`);
```

`bus.publish` only issues the cross-process `NOTIFY`; Postgres delivers it back to
*every* node (this one included) in commit order, where each node's ring records it
once and the hub fans it out. Mount the handler with `hub: bus.hub, ring: bus.ring`.

**Publish after the write's `await` resolves — never before.** A publish before
commit is the one non-resync-recoverable failure: a subscriber refetches the
pre-write state and spends the invalidation on it.

## Go live in the browser

Pair a `useLive` subscription with a `useQuery` reading the same topics, from
[`@lesto/ui`](/batteries/data). The query goes live: it refetches the instant a
peer's write dirties one of its topics.

```tsx
import { useLive, useQuery } from "@lesto/ui";

function Room({ roomId }: { roomId: string }) {
  // ONE subscription for the whole view — each useLive opens its own EventSource.
  useLive([`room:${roomId}`]);

  const messages = useQuery(
    ["messages", roomId],
    () => fetch(`/messages?room=${roomId}`).then((r) => r.json()),
    { topics: [`room:${roomId}`] },
  );

  // messages.data refetches the moment a peer posts to this room.
}
```

The refetch calls the **same authorized endpoint** the query always uses, so an
invalidation-driven refetch can only ever return rows the principal may already see.

## Resume, heartbeats, and backpressure

- **Missed-message resume.** Each connection reconnects with its last cursor
  (`Last-Event-ID`); the `ReplayRing` — an `(instanceId, generation, index)` cursor
  with resync-by-default — replays exactly the topics missed since it, or emits a
  `resync` (refetch everything the connection subscribes to) when it cannot prove
  continuity. `EventSource` handles the reconnect and the resume header natively.
- **Heartbeats** (a `: ping` comment every 30s) hold the stream open past a
  reverse proxy's idle timeout; the SSE headers also defeat proxy buffering.
- **Backpressure.** A slow client whose per-connection buffer (default 256) fills is
  dropped to a `resync` and closed — it never stalls the shared delivery stream.
- **Continuous re-auth (optional).** Wire `revalidate` to re-resolve session
  validity on an interval (default 60s); a revoked or expired session has its stream
  severed rather than left open. A `maxConnectionMs` bounds any connection's lifetime.

## Notes and gotchas

- **Topics, never rows.** The wire carries a key string; the row is refetched
  through your authorized read. For the rows themselves on a local, offline-capable
  store, reach for [local-first sync](/batteries/live) — the other product, on its
  own wire.
- **Publish after commit**, never before.
- **One `EventSource` per `useLive`.** Call it once, high in a view, subscribing to
  every topic that view needs — not once per list row (that exhausts the browser's
  per-origin connection budget and the server's per-IP stream cap).
- **DB-backed pub/sub also ships.** The in-process hub and the transport-neutral
  fan-out core live in [`@lesto/pubsub`](/batteries/pubsub); for durable,
  cross-process work, use [the queue](/batteries/queue).

## See also

- [Data](/batteries/data) — the typed query builder and the `useQuery` cache this
  makes live.
- [Local-first sync](/batteries/live) — the rows on a durable local replica, with
  offline writes (preview).
- [Pub/sub](/batteries/pubsub) — the in-process hub and WebSocket fan-out beneath
  the transport.
