/**
 * The multi-client e2e liveness gate (`L-a34a410e`) — and the browser-facing proof for
 * `L-dd3cdca1` + `L-85655d2c`: drive the reactive app over a LIVE node:http server with
 * real SSE clients, and assert a mutation on one client fans out to every OTHER.
 *
 * `@lesto/realtime` tests the fan-out core in-process; `@lesto/ui` unit-tests the
 * `connectLive` consumer. This closes the gap between them: two real SSE connections over
 * real sockets, a real `POST`, and the invalidation frame arriving on both — the
 * "live `useQuery`" moment, end to end. It also asserts the security floor: a client that
 * subscribes to a room it may not see receives **nothing** — no delivery, no timing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { openSqlite, serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";

import { buildApp } from "../src/app";
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
  booted = await buildApp({ handle: handle.db });
  server = await serve(booted.app, { port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  for (const client of open.splice(0)) client.close();
});

afterAll(async () => {
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

/** Wait until `topic` has at least `n` live subscribers (so a publish reaches them). */
async function waitForSubscribers(topic: string, n: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (booted.hub.subscriberCount(topic) >= n) return;

    await new Promise((r) => setTimeout(r, 5));
  }

  throw new Error(
    `expected ${n} subscribers on ${topic}, saw ${booted.hub.subscriberCount(topic)}`,
  );
}

/** POST a message as `user` to `room`, returning the HTTP status. */
async function post(user: string, room: string, text: string): Promise<number> {
  const res = await fetch(`${base}/messages?user=${user}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room, text }),
  });

  return res.status;
}

describe("reactive example — multi-client liveness (ADR 0027 Phase 2 / ADR 0040)", () => {
  it("fans a mutation out to every subscribed client, and the refetch sees the new row", async () => {
    const alice = await openSse("/__lesto/live?topics=room:general&user=alice");
    const bob = await openSse("/__lesto/live?topics=room:general&user=bob");
    await waitForSubscribers("room:general", 2);

    expect(await post("alice", "general", "hello")).toBe(201);

    // Both held connections receive the invalidation — no app WebSocket code, live.
    const a = await alice.waitFor((f) => f.event === "invalidate" && f.data === "room:general");
    const b = await bob.waitFor((f) => f.event === "invalidate" && f.data === "room:general");
    expect(a.data).toBe("room:general");
    expect(b.data).toBe("room:general");

    // The live loop: the authorized re-read a client makes on invalidation now sees the row.
    const read = await fetch(`${base}/messages?room=general&user=bob`).then((r) => r.json());
    expect((read.messages as Array<{ text: string }>).map((m) => m.text)).toContain("hello");
  });

  it("drops an unauthorized subscription — no delivery, no change-timing signal", async () => {
    const member = await openSse("/__lesto/live?topics=room:secret&user=alice");
    const outsider = await openSse("/__lesto/live?topics=room:secret&user=bob");

    // Only alice (a member) subscribes; bob's `room:secret` was dropped at subscribe time.
    await waitForSubscribers("room:secret", 1);
    expect(booted.hub.subscriberCount("room:secret")).toBe(1);

    expect(await post("alice", "secret", "classified")).toBe(201);

    // The member receives the invalidation…
    const m = await member.waitFor((f) => f.event === "invalidate" && f.data === "room:secret");
    expect(m.data).toBe("room:secret");

    // …and by the time it did (same synchronous fan-out), the outsider has received NOTHING
    // for the secret room — not the data, not even the timing. Its connection is open (it
    // still heart-beats), just silent about a room it may not see.
    expect(outsider.frames.some((f) => f.data === "room:secret")).toBe(false);

    // The drop was surfaced for logging, never delivered to the client.
    expect(booted.dropped).toContainEqual({ user: "bob", topics: ["room:secret"] });
  });

  it("gates the read and the write by the same room-access rule (the refetch re-authorizes)", async () => {
    // bob may not READ a private room he cannot see…
    expect((await fetch(`${base}/messages?room=secret&user=bob`)).status).toBe(403);

    // …nor WRITE to it (no back-door publish to a room the principal cannot access).
    expect(await post("bob", "secret", "sneaky")).toBe(403);
  });
});
