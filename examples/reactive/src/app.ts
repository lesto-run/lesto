/**
 * A live-queries app: a chat-room read that stays in sync across clients (ADR 0027
 * Phase 2 over the ADR 0040 SSE transport), with per-subscription authorization.
 *
 * The shape this example exists to prove:
 *   - **Live fan-out.** A `POST /messages` on one client refetches the `GET /messages`
 *     `useQuery` on every OTHER subscribed client — with NO app WebSocket code. The
 *     mutation records the room's invalidation topic in the replay ring (assigning the
 *     global, commit-ordered cursor) and publishes it to the in-process hub, which the
 *     mounted `GET /__lesto/live` SSE fan-out delivers to each held connection.
 *   - **Per-subscription authz (the `L-85655d2c` seam).** `authorizeTopic` gates every
 *     subscription against the connection's principal. An unauthorized topic is
 *     **dropped, not refused** — so a viewer of a private room learns nothing about it,
 *     not even the change-*timing* (ADR 0027's side-channel). Reads and writes are gated
 *     by the SAME room-access rule, so the refetch a client makes on invalidation only
 *     ever returns rows it may see.
 *
 * Single-node on purpose: the hub + ring live in this process, so the fan-out reaches
 * every client connected to THIS node. A multi-node deploy swaps the manual
 * `ring.record` + `hub.publish` below for `createRealtimeBus` + a `PostgresTransport`
 * (ADR 0040) — the app code above the bus does not change.
 */

import { createApp } from "@lesto/kernel";
import type { App, KernelDatabase } from "@lesto/kernel";
import { PubSub } from "@lesto/pubsub";
import { ReplayRing, createRealtimeHttpHandlers } from "@lesto/realtime";
import { lesto } from "@lesto/web";
import type { Context } from "@lesto/web";

import { demoPage } from "./demo-page";

/** One posted message — the row a `useQuery("messages", …)` reads and re-reads live. */
export interface Message {
  id: number;
  room: string;
  text: string;
  user: string;
  at: string;
}

/** The acting principal: who is connected, and which private rooms they belong to. */
export interface Principal {
  readonly user: string | undefined;

  readonly rooms: ReadonlySet<string>;
}

/**
 * The demo tenancy. `general` is a PUBLIC room anyone (even anonymous) may see; `secret`
 * is members-only, and only `alice` is a member. A real app reads membership from its own
 * tables; a small map stands in here.
 */
const PUBLIC_ROOMS: ReadonlySet<string> = new Set(["general"]);
const MEMBERSHIP: Readonly<Record<string, ReadonlySet<string>>> = {
  alice: new Set(["secret"]),
  bob: new Set<string>(),
};

/** Resolve a `?user=` value into its principal (its private-room membership). */
export function principalOf(user: string | undefined): Principal {
  const rooms = user === undefined ? new Set<string>() : (MEMBERSHIP[user] ?? new Set<string>());

  return { user, rooms };
}

/** May this principal SEE `room`? (public, or a member) — the one rule reads/writes/subs share. */
export function mayAccessRoom(principal: Principal, room: string): boolean {
  return PUBLIC_ROOMS.has(room) || principal.rooms.has(room);
}

/** The room a `room:<id>` topic addresses, or `undefined` for a non-room topic. */
export function roomOfTopic(topic: string): string | undefined {
  return topic.startsWith("room:") ? topic.slice("room:".length) : undefined;
}

/** What {@link buildApp} returns: the booted app plus the handles the demo / tests read. */
export interface Booted {
  app: App;

  /** The in-process hub the SSE fan-out subscribes to (channels = topics). */
  hub: PubSub;

  /** The process replay ring — records each published topic, assigns the global cursor. */
  ring: ReplayRing;

  /** The posted messages (in-memory for the demo; a real app persists them). */
  messages: Message[];

  /** Every dropped (unauthorized) subscription, surfaced for logging — never delivered. */
  dropped: Array<{ user: string | undefined; topics: readonly string[] }>;
}

/** Boot the reactive app: the read, the mutation, and the mounted SSE fan-out. */
export async function buildApp(options: { handle: KernelDatabase }): Promise<Booted> {
  const hub = new PubSub();
  const ring = new ReplayRing({ instanceId: "reactive-demo", maxEntries: 1000, maxAgeMs: 300_000 });
  const messages: Message[] = [];
  const dropped: Array<{ user: string | undefined; topics: readonly string[] }> = [];

  // Resolve the principal from `?user=` — a session cookie in production, but a query here
  // because a browser `EventSource` cannot set an auth header on its GET.
  const resolvePrincipal = (c: Context): Principal => principalOf(c.query("user") ?? undefined);

  // Authorize ONE topic against the principal (the `L-85655d2c` seam). A `room:<id>` topic
  // is allowed iff the principal may see that room; the unauthorized topic is DROPPED (see
  // `onDropped`), never refused — so a client never learns a room it cannot see even exists.
  const authorizeTopic = (principal: Principal, topic: string): boolean => {
    const room = roomOfTopic(topic);

    return room !== undefined && mayAccessRoom(principal, room);
  };

  const realtime = createRealtimeHttpHandlers<Principal>({
    hub,
    ring,
    resolvePrincipal,
    authorizeTopic,
    onDropped: (principal, topics) => {
      dropped.push({ user: principal.user, topics });
    },
  });

  const api = lesto()
    // The live SSE fan-out (ADR 0040). The runtime recognizes this reserved path as a
    // long-lived stream, so the held connection takes no in-flight slot and is never
    // compressed — the app just mounts the handler.
    .get("/__lesto/live", realtime.live)

    // The authorized READ a `useQuery` calls (and refetches on invalidation), gated by the
    // SAME room-access rule as the subscription — so an invalidation-driven refetch can only
    // ever return rows the principal may see.
    .get("/messages", (c) => {
      const room = c.query("room") ?? "";
      const principal = principalOf(c.query("user") ?? undefined);

      if (!mayAccessRoom(principal, room)) return c.json({ error: "forbidden" }, 403);

      return c.json({ messages: messages.filter((m) => m.room === room) });
    })

    // The MUTATION: append a message, then publish the room's invalidation topic. Published
    // AFTER the write lands (never before — a pre-commit publish is the one
    // non-resync-recoverable failure, ADR 0040). `ring.record` assigns the global cursor;
    // `hub.publish` fans the `(topic, cursor)` out to every subscribed live connection.
    .post("/messages", (c) => {
      const body = (c.req.body ?? {}) as { room?: unknown; text?: unknown };
      const room = String(body.room ?? "");
      const principal = principalOf(c.query("user") ?? undefined);

      if (!mayAccessRoom(principal, room)) return c.json({ error: "forbidden" }, 403);

      const message: Message = {
        id: messages.length + 1,
        room,
        text: String(body.text ?? ""),
        user: principal.user ?? "anon",
        at: new Date().toISOString(),
      };
      messages.push(message);

      const topic = `room:${room}`;
      void hub.publish(topic, ring.record(topic));

      return c.json({ message }, 201);
    })

    // The human-facing demo (open two browser tabs): a vanilla `EventSource` mirror of what
    // `@lesto/ui`'s `useQuery` + `useLive` do in a real app (see the README).
    .get("/", () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: demoPage(),
    }));

  const app = await createApp({ db: options.handle, app: api });

  return { app, hub, ring, messages, dropped };
}
