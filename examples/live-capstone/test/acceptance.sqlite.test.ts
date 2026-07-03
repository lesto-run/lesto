/**
 * The capstone's **dev-parity leg** (ADR 0042 Inc8): the SAME app, the SAME `live()` surface, on the
 * v0 SQLite poll instead of Postgres logical replication — proving dev/prod parity is REAL and stated,
 * not hidden. Real sockets, real SQLite, real SSE, over the actual multi-tenant demo.
 *
 * Scope is deliberately API-parity, NOT the full matrix: the poll path has no LSN, so it re-snapshots
 * on every reconnect (the coarse v0 floor) — LSN-exact replay + the `REPLICA IDENTITY` guards are
 * Postgres-only and live in `acceptance.pg.ts` (the epic-closing gate) + the `@lesto/live-server` unit
 * suite. What this leg proves is that the authz/liveness surface a developer builds against on SQLite
 * is byte-identical to prod: multi-client liveness, (a) parameter-authz refusal, and (c) BOTH
 * membership mechanisms (on-row sub-interval delete-from-shape + cross-relation re-auth purge).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { eq } from "@lesto/db";
import { decodeChangeData, serializeShapeDefinition } from "@lesto/live-protocol";
import type { ShapeChange } from "@lesto/live-protocol";
import { openSqlite, serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";

import { buildApp, revokeMembership } from "../src/app";
import type { Booted } from "../src/app";
import { messages, messagesInRoom } from "../src/schema";
import { openSse } from "./harness";
import type { SseClient } from "./harness";

let handle: Awaited<ReturnType<typeof openSqlite>>;
let booted: Booted;
let server: Server;
let base: string;
const open: SseClient[] = [];

beforeAll(async () => {
  handle = await openSqlite();
  // A fast re-auth interval so the (c) cross-relation test doesn't wait the 60s production default;
  // harmless to the rest (authorizeShape keeps passing for unrevoked principals on every tick).
  booted = await buildApp({
    handle: handle.db,
    source: { kind: "poll", pollMs: 50 },
    reauthMs: 100,
  });
  server = await serve(booted.app, { port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  for (const client of open.splice(0)) client.close();
});

afterAll(async () => {
  booted.engine.stop();
  await server.close();
  handle.close();
});

/** The SSE path for a room's shape (the subscribe request's trust boundary). */
function shapePath(room: string): string {
  return `/__lesto/live-data?shape=${encodeURIComponent(serializeShapeDefinition(messagesInRoom(room)))}`;
}

/** Open a tracked SSE client for a room as a user. */
async function subscribe(room: string, user: string): Promise<SseClient> {
  const client = await openSse(base, shapePath(room), { user });
  open.push(client);

  return client;
}

/** POST a message to `room` as `user` with a client-minted id, returning [status, id]. */
async function postMessage(user: string, room: string, body: string): Promise<[number, string]> {
  const id = crypto.randomUUID();
  const res = await fetch(`${base}/messages?user=${user}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, room, body }),
  });

  return [res.status, id];
}

describe("capstone — dev-parity leg (ADR 0042 Tier 4 v1 on the SQLite poll)", () => {
  it("streams a write on one client to every other subscribed client", async () => {
    const alice = await subscribe("lobby", "alice");
    const bob = await subscribe("lobby", "bob");

    await alice.waitFor((f) => f.event === "snapshot");
    await bob.waitFor((f) => f.event === "snapshot");

    const [status] = await postMessage("alice", "lobby", "hello everyone");
    expect(status).toBe(201);

    const a = decodeChangeData((await alice.waitFor((f) => f.event === "change")).data);
    const b = decodeChangeData((await bob.waitFor((f) => f.event === "change")).data);

    expect(a).toMatchObject({ op: "insert", row: { body: "hello everyone" } });
    expect(b).toMatchObject({ op: "insert", row: { body: "hello everyone" } });
  });

  it("(a) refuses a shape bound to a room the principal may not see (403, before any stream)", async () => {
    // bob is not a member of `engineering` → the bound-`room_id` capability check fails at subscribe
    // time, so the connection never opens. A plain fetch (not the SSE harness) sees the 403.
    const denied = await fetch(`${base}${shapePath("engineering")}&user=bob`, {
      headers: { accept: "text/event-stream" },
    });
    expect(denied.status).toBe(403);
    await denied.text();

    // The SAME shape as alice (a member) opens a live `text/event-stream`.
    const controller = new AbortController();
    const allowed = await fetch(`${base}${shapePath("engineering")}&user=alice`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });

  it("gates the write by the same room-access rule (no back-door into a private room)", async () => {
    const [status] = await postMessage("bob", "engineering", "sneaky");
    expect(status).toBe(403);
  });

  it("(c) on-row: reassigning room_id — the shape's own predicate column — delivers delete-from-shape sub-interval", async () => {
    const alice = await subscribe("engineering", "alice");
    await alice.waitFor((f) => f.event === "snapshot");

    const [status, id] = await postMessage("alice", "engineering", "reassign me");
    expect(status).toBe(201);

    await alice.waitFor((f) => f.event === "change" && decodeChangeData(f.data).op === "insert");

    // Move the row OUT of the shape by reassigning its OWN room_id — no membership relation, no re-auth
    // wait: the poll classifier observes the row's own change and emits the delete-from-shape at once.
    await booted.db.update(messages).set({ roomId: "lobby" }).where(eq(messages.id, id)).run();

    const deleteFrame = await alice.waitFor(
      (f) => f.event === "change" && decodeChangeData(f.data).op === "delete",
      1000,
    );
    expect(decodeChangeData(deleteFrame.data)).toEqual({
      op: "delete",
      key: id,
    } satisfies ShapeChange);
  });

  it("(c) cross-relation: revoking membership — a relation the messages stream can't see — purges the slice within the reauth interval", async () => {
    // `carol`, not `alice` — a dedicated principal so this revoke can't affect another test's
    // assumption that alice stays an `engineering` member regardless of order.
    const carol = await subscribe("engineering", "carol");
    await carol.waitFor((f) => f.event === "snapshot");

    // Nothing about any `messages` row changes — only the SEPARATE membership relation does. Only the
    // periodic authorizeShape re-check (100ms here) can catch it, and it always purges before severing.
    revokeMembership("carol", "engineering");

    const resync = await carol.waitFor((f) => f.event === "resync", 1000);
    expect(resync.event).toBe("resync");
  });
});
