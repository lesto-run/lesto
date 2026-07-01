/**
 * The `live()` end-to-end capstone (ADR 0042 Tier 4 v0). The sibling `live.test.ts` proves
 * the SERVER wire with raw SSE sockets; THIS test proves the whole CLIENT vertical — the
 * `@lesto/live` store + SSE consumer + the `live()` ORM builder — driving the SAME real
 * served endpoint. It is the "moat, made real" moment: one `live(todos).where(...).query()`
 * on the app's own schema yields a `LiveQuery` that receives a peer's committed write live,
 * with no socket code and no second query language.
 *
 * Node has no global `EventSource`, so we inject a tiny fetch-based `LiveEnvironment` adapter
 * (the seam `@lesto/live` exposes for exactly this) — the browser uses the native one.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { live } from "@lesto/live";
import type { LiveEnvironment } from "@lesto/live";
import { openSqlite, serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";

import { buildApp, todos } from "../src/app";
import type { Booted } from "../src/app";

let handle: Awaited<ReturnType<typeof openSqlite>>;
let booted: Booted;
let server: Server;
let base: string;

beforeAll(async () => {
  handle = await openSqlite();
  booted = await buildApp({ handle: handle.db });
  server = await serve(booted.app, { port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  booted.engine.stop();
  await server.close();
  handle.close();
});

/**
 * A minimal `EventSource`-over-`fetch` adapter for Node: stream the SSE body, split on the
 * `\n\n` frame boundary, and dispatch each named event's `data` to its listener. Enough of
 * `EventSource` for `@lesto/live`'s consumer, which only reads named events + `.data`.
 */
function nodeSseEnvironment(): LiveEnvironment {
  return {
    open(url) {
      const controller = new AbortController();
      const listeners = new Map<string, (event: { data: string }) => void>();

      void (async () => {
        const response = await fetch(url, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          for (;;) {
            const { value, done } = await reader.read();

            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            let boundary = buffer.indexOf("\n\n");

            while (boundary >= 0) {
              const raw = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf("\n\n");

              let event = "message";
              let data = "";

              for (const line of raw.split("\n")) {
                if (line === "" || line.startsWith(":")) continue;

                const colon = line.indexOf(":");
                const field = colon === -1 ? line : line.slice(0, colon);
                const val = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

                if (field === "event") event = val;
                else if (field === "data") data = data === "" ? val : `${data}\n${val}`;
              }

              listeners.get(event)?.({ data });
            }
          }
        } catch {
          // The read rejects when we abort on disconnect — the intended teardown.
        }
      })();

      return {
        addEventListener: (type, listener) => listeners.set(type, listener),
        close: () => controller.abort(),
      };
    },
  };
}

/** Poll `predicate` until true or the timeout — the async barrier the live loop needs. */
async function waitUntil(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

describe("live() end-to-end — the ORM builder driving the real stream (ADR 0042 Tier 4 v0)", () => {
  it("mints a LiveQuery from the schema that syncs a peer's write with no socket code", async () => {
    // One query on the app's OWN schema — the moat. `home` is public, so an anonymous
    // subscribe is authorized (no `?user=` on the EventSource GET).
    const query = live(todos)
      .where(todos.list, "eq", "home")
      .orderBy(todos.createdAt, "asc")
      .query({ environment: nodeSseEnvironment(), path: `${base}/__lesto/live-data` });

    // A snapshot arrives first (even empty) → the subscribe fired means we are live.
    let snapshots = 0;
    query.subscribe(() => {
      snapshots += 1;
    });
    await waitUntil(() => snapshots >= 1);

    // A peer commits a write; the engine's next poll streams the insert; the LiveQuery's
    // local store applies it — the component reading `getSnapshot()` re-renders, no refetch.
    expect(await postTodo("alice", "home", "milk via live()")).toBe(201);
    await waitUntil(() => query.getSnapshot().some((row) => row.text === "milk via live()"));

    expect(query.getSnapshot().map((row) => row.text)).toContain("milk via live()");

    query.disconnect();
  });
});
