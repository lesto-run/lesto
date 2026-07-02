/**
 * The multi-client e2e liveness + authorization gate for local-first sync (ADR 0042 Tier 4
 * v0 — the `L-a34a410e` analogue for row data). `@lesto/live-server` unit-tests the shape
 * engine + connection in-process; this closes the gap to the wire: two real SSE connections
 * over real sockets, a real `POST`, and the streamed `insert` arriving on BOTH clients — the
 * "live `useQuery` over row data" moment, end to end. It also asserts the parameter-authz
 * floor: a shape bound to a list the principal may not see is refused before any stream opens.
 *
 * The harness (`parseFrame` / `openSse` / `waitFor`) is the reactive example's SSE client,
 * reused verbatim — this track drives RAW sockets, independent of `@lesto/live`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { eq } from "@lesto/db";
import { openSqlite, serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";
import { decodeChangeData, serializeShapeDefinition } from "@lesto/live-protocol";
import type { ShapeChange } from "@lesto/live-protocol";

import { buildApp, revokeMembership, todos } from "../src/app";
import type { Booted } from "../src/app";

/** One parsed SSE event. A comment-only block (the heartbeat) parses to `undefined`. */
interface Frame {
  event: string;
  data: string;
}

/** A live SSE client: the frames seen so far, a `waitFor`, and a clean disconnect. */
interface SseClient {
  frames: Frame[];
  waitFor(pred: (frame: Frame) => boolean, ms?: number): Promise<Frame>;
  close(): void;
}

let handle: Awaited<ReturnType<typeof openSqlite>>;
let booted: Booted;
let server: Server;
let base: string;
const open: SseClient[] = [];

beforeAll(async () => {
  handle = await openSqlite();
  // A fast re-auth interval so the acceptance-matrix (c)/(d) tests don't wait the 60s
  // production default; harmless to every other test (authorizeShape keeps passing for
  // unrevoked principals on every tick, so nothing else in this file observes it firing).
  booted = await buildApp({ handle: handle.db, reauthMs: 100 });
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

/** Parse one SSE event block (`event:`/`data:` lines); a bare `:` comment yields `undefined`. */
function parseFrame(raw: string): Frame | undefined {
  let event = "message";
  let data = "";
  let saw = false;

  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

    if (field === "event") {
      event = value;
      saw = true;
    } else if (field === "data") {
      data = data === "" ? value : `${data}\n${value}`;
      saw = true;
    }
  }

  return saw ? { event, data } : undefined;
}

/** Open a live SSE connection and read its frames in the background until closed. */
async function openSse(path: string): Promise<SseClient> {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  const waiters: Array<{ pred: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  let buffer = "";

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");

        while (boundary >= 0) {
          const frame = parseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          if (frame === undefined) continue;

          frames.push(frame);

          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i]!.pred(frame)) waiters.splice(i, 1)[0]!.resolve(frame);
          }
        }
      }
    } catch {
      // The read rejects when we abort on close — the intended teardown, not a failure.
    }
  })();

  const client: SseClient = {
    frames,
    waitFor(pred, ms = 2000) {
      const existing = frames.find(pred);

      if (existing !== undefined) return Promise.resolve(existing);

      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error("SSE waitFor timed out"));
        }, ms);

        const entry = {
          pred,
          resolve: (frame: Frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        };

        waiters.push(entry);
      });
    },
    close: () => controller.abort(),
  };

  open.push(client);

  return client;
}

/** The URL-encoded serialized shape bound to one `list` — the subscribe request's trust boundary. */
function shapeFor(list: string): string {
  return encodeURIComponent(
    serializeShapeDefinition({
      table: "todos",
      key: "id",
      columns: ["id", "list", "text", "done", "createdAt"],
      where: [{ column: "list", op: "eq", value: list }],
      orderBy: { column: "createdAt", direction: "asc" },
    }),
  );
}

/** POST a todo to `list` as `user`, returning the HTTP status. */
async function postTodo(user: string, list: string, text: string): Promise<number> {
  const res = await fetch(`${base}/todos?user=${user}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ list, text }),
  });

  return res.status;
}

describe("live example — multi-client liveness + parameter authz (ADR 0042 Tier 4 v0)", () => {
  // The four tests below are the gallery-as-QA-gate dogfood for the Tier-4 v1 Inc3 acceptance
  // matrix (ADR 0042, L-f50f94d1) — real sockets, real SQLite, real SSE, over the actual
  // multi-tenant demo, not a synthesized rig. (b)/(d)/(e) are dogfooded at the deterministic
  // unit level in `packages/live-server/test` (see its "ADR 0042 acceptance matrix" describe).

  it("streams a write on one client to every other subscribed client", async () => {
    const shape = shapeFor("home");
    const alice = await openSse(`/__lesto/live-data?shape=${shape}&user=alice`);
    const bob = await openSse(`/__lesto/live-data?shape=${shape}&user=bob`);

    // Both connect and receive the initial `snapshot`. Waiting for it guarantees each is
    // subscribed in the engine, so the write below is observed by both — the ordering the
    // reference achieves with `waitForSubscribers`.
    expect((await alice.waitFor((f) => f.event === "snapshot")).event).toBe("snapshot");
    expect((await bob.waitFor((f) => f.event === "snapshot")).event).toBe("snapshot");

    expect(await postTodo("alice", "home", "buy milk")).toBe(201);

    // Within one poll tick (~50ms) the engine diffs the shape and streams the `insert` — no
    // app socket code, no refetch — to BOTH held connections.
    const a = decodeChangeData((await alice.waitFor((f) => f.event === "change")).data);
    const b = decodeChangeData((await bob.waitFor((f) => f.event === "change")).data);

    expect(a).toMatchObject({ op: "insert", row: { text: "buy milk" } });
    expect(b).toMatchObject({ op: "insert", row: { text: "buy milk" } });
  });

  it("(a) refuses a shape bound to a list the principal may not see (403, before any stream)", async () => {
    const shape = shapeFor("work");

    // bob is not a member of `work` → the bound-`list` capability check fails at subscribe
    // time, so the connection never opens. A plain fetch (NOT the SSE harness) sees the 403.
    const denied = await fetch(`${base}/__lesto/live-data?shape=${shape}&user=bob`, {
      headers: { accept: "text/event-stream" },
    });
    expect(denied.status).toBe(403);
    await denied.text();

    // The SAME shape as alice (a member) opens a live `text/event-stream`. The bound `list`
    // value is the capability, authorized server-side — that is the whole point.
    const controller = new AbortController();
    const allowed = await fetch(`${base}/__lesto/live-data?shape=${shape}&user=alice`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });

  it("gates the write by the same list-access rule (no back-door into a private list)", async () => {
    // bob may not WRITE to a private list he cannot see — the read/subscribe/write rule is one.
    expect(await postTodo("bob", "work", "sneaky")).toBe(403);
  });

  it("(c) on-row: reassigning a todo's list — the shape's own predicate column — delivers delete-from-shape sub-interval, no reauth wait", async () => {
    const shape = shapeFor("work");
    const alice = await openSse(`/__lesto/live-data?shape=${shape}&user=alice`);
    await alice.waitFor((f) => f.event === "snapshot");

    expect(await postTodo("alice", "work", "reassign me")).toBe(201);

    const insertFrame = await alice.waitFor(
      (f) => f.event === "change" && decodeChangeData(f.data).op === "insert",
    );
    const inserted = decodeChangeData(insertFrame.data) as Extract<ShapeChange, { op: "insert" }>;
    const id = (inserted.row as { id: number }).id;

    // Move the row OUT of the shape by reassigning its OWN `list` column — no membership
    // relation involved, no re-auth interval to wait on: the poll/replication classifier
    // observes the row's own change directly and emits the delete-from-shape immediately.
    await booted.db.update(todos).set({ list: "home" }).where(eq(todos.id, id)).run();

    const deleteFrame = await alice.waitFor(
      (f) => f.event === "change" && decodeChangeData(f.data).op === "delete",
      1000,
    );
    expect(decodeChangeData(deleteFrame.data)).toEqual({ op: "delete", key: String(id) });
  });

  it("(c) cross-relation: revoking membership — a relation the todos stream can't see — purges the client's slice within the reauth interval", async () => {
    const shape = shapeFor("work");
    // `carol`, not `alice` — a dedicated principal so this revoke can't affect any other test's
    // assumption that alice stays a `work` member regardless of test order.
    const carol = await openSse(`/__lesto/live-data?shape=${shape}&user=carol`);
    await carol.waitFor((f) => f.event === "snapshot");

    // Nothing about ANY `todos` row changes — only the SEPARATE membership relation does. The
    // poll/replication classifier has nothing on the `todos` table to observe; only the
    // periodic `authorizeShape` re-check (the re-auth interval, 100ms in this suite) can catch
    // it — and per the mandatory-re-auth mechanism (L-f50f94d1), it always purges before severing.
    revokeMembership("carol", "work");

    const resync = await carol.waitFor((f) => f.event === "resync", 1000);
    expect(resync.event).toBe("resync");
  });
});
