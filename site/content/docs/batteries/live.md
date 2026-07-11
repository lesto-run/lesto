---
title: Local-first sync
navLabel: Local-first
description: "A durable, offline-capable replica of an auth-scoped slice of your database in the browser, defined with the live() builder over your @lesto/db schema. Preview."
section: Batteries
order: 14.6
---

# Local-first sync

> [!IMPORTANT]
> **Preview — v1, in active hardening.** Local-first sync is shipped and gated
> end-to-end (the `examples/live-capstone` CI gate), but its surface will move
> before it becomes a supported, published package — `@lesto/live` is not yet on
> npm. What we claim today, precisely: **local-first sync, v1: Postgres logical
> replication to a durable local store with offline writes — in active hardening.**
> Not "production-ready offline sync," and not "sync any query offline." The honest
> scope and caveats are in [Scope and caveats](#scope-and-caveats-v1) below — read
> them before you reach for this.

Where [realtime](/batteries/realtime) pushes a *topic* and your query refetches
through the server, local-first sync puts the **rows themselves** into a durable
store in the browser. Your component reads them locally — no round-trip,
offline-capable — and writes to them optimistically while offline, reconciling when
the connection returns. It is a different product from reactivity, on a different
wire, for a different job: reactivity keeps a live view fresh; local-first keeps a
queryable replica on the device. (See [ADR 0042](https://github.com/lesto-run/lesto/blob/main/docs/adr/0042-local-first-sync-tier-4.md).)

The unit of sync is a **shape**: a single-table read query, evaluated for one
authorized principal. You define it with the `live()` builder — over the same
`@lesto/db` schema you already write with.

## Define a shape with `live()`

`live(table)` opens a typed, fluent builder over a `@lesto/db` table. It is a **free
function** you import — not a `.live()` method on the query builder — and it reads
only the table's metadata, so pulling it into the client bundle drags in no
server or database runtime.

```ts
import { live } from "@lesto/live";
import { messages } from "./schema";

const room = live(messages)
  .where(messages.roomId, "eq", roomId)
  .orderBy(messages.createdAt, "asc")
  .query();
//  ^ LiveQuery<Message> — reads from the local store, stays in sync, writable offline
```

- **`.where(column, op, value)`** adds an AND-combined filter. The operators are the
  simple ones: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`.
- **`.orderBy(column, direction?)`** fixes the sort (`"asc"` by default); the shape's
  key breaks ties, so the order is total and deterministic.
- **`.query(options?)`** opens the subscription and returns a `LiveQuery<Row>` — a
  `{ subscribe, getSnapshot, disconnect }` handle, exactly the shape a React external
  store wants. `.toShape()` instead compiles and validates the `ShapeDefinition`
  *without* opening a stream, so a bound shape can be shared between client and server.

The bound value — `roomId` here — is both the **sync filter** (which rows stream) and
the **capability** the server authorizes at subscribe time. A client *names* a shape;
it does not author the authorization predicate. The server binds the principal's own
scope server-side and streams only the rows that satisfy it.

## Read it in React

`useLiveQuery`, on the `@lesto/live/react` subpath, binds a `LiveQuery` to a
component. It takes a **factory** and a `deps` array — the re-subscribe key, exactly
like `useEffect`. The stream opens on the client after mount and tears down on
unmount; a server render returns the empty set. Importing `@lesto/live` itself pulls
in no React.

```tsx
import { live } from "@lesto/live";
import { useLiveQuery } from "@lesto/live/react";
import { messages } from "./schema";

function Room({ roomId }: { roomId: string }) {
  const rows = useLiveQuery(
    () =>
      live(messages)
        .where(messages.roomId, "eq", roomId)
        .orderBy(messages.createdAt, "asc")
        .query(),
    [roomId],
  );

  return (
    <ul>
      {rows.map((m) => (
        <li key={m.id}>
          {m.author}: {m.body}
        </li>
      ))}
    </ul>
  );
}
```

## The durable store, offline writes, and cross-tab

- **The store.** The default is an in-memory keyed store (lost on reload — fine for
  live views). Opt into durability with `createSqliteLiveStore`, backed by
  OPFS-SQLite via the `@lesto/live/opfs` subpath: a real local SQLite that survives
  reload and persists its resume cursor *atomically* with the rows, so a crash never
  leaves rows ahead of the cursor.
- **Offline writes.** `createLiveMutations` is the write outbox: a write is applied
  to the store optimistically and durably logged, then replayed on reconnect through
  the app's **normal authorized `POST` mutation** — the same validation, authz, and
  CSRF every online write passes. There is no bespoke sync-write server. A
  server-rejected write rolls back locally; each optimistic row carries a
  client-generated id so the server's echo correlates back to it rather than
  duplicating.
- **Cross-tab.** `createCrossTabLiveQuery` elects one **leader tab** (over Web Locks)
  to hold the connection and the durable store; a BroadcastChannel fans the leader's
  rendered slice to follower tabs, which mirror it without a connection of their own.
  Leadership fails over automatically on tab close. It returns the same `LiveQuery`
  handle, so `useLiveQuery` binds it unchanged.

## Scope and caveats (v1)

v1 is deliberately bounded. Read this before building on it.

- **Single-table, simple filters.** A shape is one table with AND-combined
  equality/range filters. Multi-table and joined shapes are vNext.
- **Last-write-wins.** Conflicting writes resolve last-write-wins. Per-field CRDTs
  (Yjs/Loro) are a deferred opt-in, not v1.
- **Offline writes work; a fully-offline *reload* does not yet.** A write made
  offline is applied locally, survives reload (with the durable store), and
  reconciles on reconnect. But there is no service worker yet, so a cold reload while
  fully offline still needs the network to fetch the app shell.
- **The durable store is browser-only.** OPFS-SQLite runs in a dedicated Worker
  (its `createSyncAccessHandle` is Worker-exposed only). There is no main-thread or
  Node durable engine — the durable path is covered by a recorded real-browser run,
  not the Node gate.
- **Requires Postgres logical replication + `REPLICA IDENTITY FULL`.** The v1 engine
  taps Postgres logical replication, and every table backing a shape must run
  `REPLICA IDENTITY FULL` so the server can see a row's old image and tell when a row
  *left* a shape — otherwise a row the principal lost access to would silently remain
  in the client's durable store. The shape engine **refuses** a shape whose table
  cannot supply that old image rather than leaking.
- **Operational footgun: single-writer.** The shape engine is the single consumer of
  its replication slot and **must run as one machine.** A replication slot pins WAL
  until its consumer acknowledges it, so a stalled or duplicated consumer accumulates
  WAL and can fill the database disk. Run one, alert on slot lag, and drop the slot on
  shutdown.

For the dev loop, the SQLite path uses a poll/trigger stand-in behind the same
`live()` seam, so local development matches the shape of production. SQLite has no
LSN, though, so it resyncs on every reconnect rather than replaying precisely — the
`live()` *surface* is identical; the resume guarantee is the coarse floor until the
Postgres path is in play.

## Try it

The end-to-end proof is
[`examples/live-capstone`](https://github.com/lesto-run/lesto/tree/main/examples/live-capstone) —
a cross-tab, offline-capable chat room over the durable store and the outbox, with an
adversarial multi-tenant authorization matrix as its CI gate. It is the honest state
of the art: shipped, gated, and in hardening.

## See also

- [Realtime](/batteries/realtime) — the reactive sibling (topics, not rows), when you
  don't need a local replica.
- [Data](/batteries/data) — the `@lesto/db` schema `live()` builds its shapes over.
- [ADR 0042](https://github.com/lesto-run/lesto/blob/main/docs/adr/0042-local-first-sync-tier-4.md)
  — the full design, the per-row authorization model, and the review history.
