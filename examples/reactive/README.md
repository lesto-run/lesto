# Live queries — the reactive example

A mutation on one client refetches a `useQuery` on **every other** client, live, with no app
WebSocket code — ADR 0027 Phase 2 ("live `useQuery`") riding the ADR 0040 SSE transport. This is
the gallery's multi-client **liveness gate** (`L-a34a410e`): the feature is not done until an
example proves it end to end over real sockets.

## What it proves

- **Live fan-out.** `POST /messages` records the room's invalidation **topic** in the replay ring
  (assigning the global, commit-ordered cursor) and publishes it to the in-process hub. The
  app-mounted `GET /__lesto/live` SSE handler fans that `(topic, cursor)` out to every held
  connection, which the browser turns into a `QueryClient.invalidateTopic` → the `useQuery`
  refetches. The wire carries a **topic, never row data** (the ADR 0027 invariant).
- **Per-subscription authorization** (`L-85655d2c`). Every subscription is authorized against the
  connection's principal. An unauthorized topic is **dropped, not refused** — so a viewer of a room
  it may not see learns *nothing*, not even the change-*timing* (ADR 0027's side-channel). Reads and
  writes are gated by the **same** room-access rule, so an invalidation-driven refetch only ever
  returns rows the principal may see.

The demo tenancy: `general` is public; `secret` is members-only, and only `alice` is a member.

## Run it

```sh
bun run examples/reactive/serve.ts          # http://127.0.0.1:3000
```

Open the page in **two browser tabs**, post in one, and watch it appear in the other with no reload.
Switch a tab to `bob` on the `secret` room: bob is not a member, so bob's tab never receives the
update — not the data, not even its timing.

```sh
bun run --cwd examples/reactive test        # the multi-client e2e liveness gate
```

The test boots the app behind `@lesto/runtime`'s `serve` and drives **two real SSE clients** over
real sockets: it asserts a `POST` fans out to both, that the authorized re-read then sees the new
row, and that an unauthorized subscriber receives nothing (no delivery, no timing) while a member
does.

## The browser side (what a real app writes)

The demo page (`src/demo-page.ts`) hand-rolls the `EventSource` glue so it needs no island build. In
a real Lesto app you write none of it — you use `@lesto/ui`:

```tsx
import { useQuery, useLive } from "@lesto/ui";

function Room({ room }: { room: string }) {
  const topics = [`room:${room}`];

  // Read the messages through the authorized endpoint…
  const { data } = useQuery(["messages", room], () =>
    fetch(`/messages?room=${room}`).then((r) => r.json()), { topics });

  // …and go LIVE: connect to the SSE fan-out and refetch whenever `room:<room>` invalidates.
  useLive(topics);

  return <ul>{data?.messages.map((m) => <li key={m.id}>{m.user}: {m.text}</li>)}</ul>;
}
```

`useLive` opens `GET /__lesto/live?topics=room:<room>`, receives the `invalidate`/`resync` frames,
and drives `invalidateTopic` on the shared `QueryClient` — exactly what the vanilla demo page does by
hand. `EventSource` handles reconnect and the resume cursor (`Last-Event-ID`) natively.

## Single-node vs a fleet

This example is single-node: the hub + ring live in one process, so the fan-out reaches every client
connected to **this** node. A multi-node deploy swaps the `ring.record` + `hub.publish` in
`src/app.ts` for `createRealtimeBus` + a `PostgresTransport` (ADR 0040) — a write on one node
`NOTIFY`s the others, whose round-trip records the global cursor and fans out locally. The app code
above the bus does not change.

**Workers/edge tier:** the runtime long-lived-stream response kind the SSE handler rides already
works on Cloudflare Workers; the cross-node fan-out point there is a Durable Object holding
subscribers for a key range (ADR 0040 Phase C, deferred).
