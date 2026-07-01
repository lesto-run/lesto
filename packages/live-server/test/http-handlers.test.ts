import { describe, expect, it, vi } from "vitest";

import { shapeId } from "@lesto/live-protocol";
import type { Cursor, Row, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";
import type { Context, Next } from "@lesto/web";

import {
  createLiveDataHttpHandlers,
  LiveServerError,
  openShapeStream,
  subscribeSource,
} from "../src/index";
import type {
  ShapeChangeListener,
  ShapeEngine,
  ShapeStreamSource,
  StreamTimers,
} from "../src/index";

// ---------------------------------------------------------------------------
// Rigs
// ---------------------------------------------------------------------------

const def: ShapeDefinition = {
  table: "messages",
  key: "id",
  columns: ["id", "body"],
  where: [],
  orderBy: undefined,
};

/** A controllable stream-timer seam — the test fires each registered timer by hand. */
function fakeStreamTimers() {
  const intervalCbs: Array<() => void> = [];
  const timeoutCbs: Array<() => void> = [];
  const cleared: unknown[] = [];
  let next = 0;

  const seam: StreamTimers = {
    setInterval: (cb) => {
      intervalCbs.push(cb);

      return `i${next++}`;
    },
    clearInterval: (handle) => cleared.push(handle),
    setTimeout: (cb) => {
      timeoutCbs.push(cb);

      return `t${next++}`;
    },
    clearTimeout: (handle) => cleared.push(handle),
  };

  return { seam, intervalCbs, timeoutCbs, cleared };
}

/** A hand-fed source: capture `onChange`, expose `fire` to push a change. */
function fakeSource(snapshot: readonly Row[] = [{ id: 1, body: "hi" }], cursor: Cursor = "c0") {
  let deliver: ((change: ShapeChange, cursor: Cursor) => void) | undefined;
  const close = vi.fn();

  const source: ShapeStreamSource = {
    snapshot,
    cursor,
    onChange: (next) => {
      deliver = next;
    },
    close,
  };

  return { source, close, fire: (c: ShapeChange, cur: Cursor) => deliver?.(c, cur) };
}

/** Read the next enqueued frame, or `undefined` at end-of-stream. */
async function readFrame(reader: ReadableStreamDefaultReader<string>): Promise<string | undefined> {
  const { value, done } = await reader.read();

  return done ? undefined : value;
}

const insert: ShapeChange = { op: "insert", key: "2", row: { id: 2, body: "yo" } };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A stub engine that captures the change listener so a test can fire changes by hand. */
function stubEngine(): { engine: ShapeEngine; fire: ShapeChangeListener; unsub: () => void } {
  let captured: ShapeChangeListener | undefined;
  const unsub = vi.fn();

  const engine = {
    subscribe: async (shape: ShapeDefinition, onChange: ShapeChangeListener) => {
      captured = onChange;

      return { shapeId: shapeId(shape), snapshot: [{ id: 1 }], cursor: "c0", unsubscribe: unsub };
    },
    activeShapes: 1,
    stop: () => {},
  } as ShapeEngine;

  return { engine, fire: (c, cur) => captured?.(c, cur), unsub };
}

/** A stub engine whose subscribe returns a fixed snapshot (no live changes). */
function engineReturning(snapshot: readonly Row[]): ShapeEngine {
  return {
    subscribe: async (shape: ShapeDefinition) => ({
      shapeId: shapeId(shape),
      snapshot,
      cursor: "c0",
      unsubscribe: () => {},
    }),
    activeShapes: 1,
    stop: () => {},
  } as ShapeEngine;
}

/** A minimal fake context: query params + optional abort signal. */
function fakeContext(query: Record<string, string>, signal?: AbortSignal): Context {
  return {
    query: (name: string) => query[name],
    signal,
  } as unknown as Context;
}

/** The handler never delegates, so `next` is a never-called stub of the right shape. */
const noopNext: Next = async () => ({ status: 500, headers: {}, body: "" });

// ---------------------------------------------------------------------------
// subscribeSource
// ---------------------------------------------------------------------------

describe("subscribeSource — the snapshot→tail bridge", () => {
  it("buffers changes that arrive before onChange, then flushes them in order", async () => {
    const { engine, fire } = stubEngine();
    const source = await subscribeSource(engine, def);

    // Two changes arrive before the stream attaches.
    fire(insert, "c1");
    fire({ op: "delete", key: "9" }, "c2");

    const delivered: Array<[ShapeChange, Cursor]> = [];
    source.onChange((change, cursor) => delivered.push([change, cursor]));

    expect(delivered).toEqual([
      [insert, "c1"],
      [{ op: "delete", key: "9" }, "c2"],
    ]);

    // A later change flows straight through.
    fire({ op: "update", key: "1", row: { id: 1 } }, "c3");
    expect(delivered).toHaveLength(3);
  });

  it("exposes the snapshot/cursor and wires close to unsubscribe", async () => {
    const { engine, unsub } = stubEngine();
    const source = await subscribeSource(engine, def);

    expect(source.snapshot).toEqual([{ id: 1 }]);
    expect(source.cursor).toBe("c0");

    source.close();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// openShapeStream
// ---------------------------------------------------------------------------

describe("openShapeStream", () => {
  it("emits the snapshot, then tails changes", async () => {
    const timers = fakeStreamTimers();
    const src = fakeSource();

    const stream = openShapeStream({
      source: src.source,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
    });
    const reader = stream.getReader();

    expect(await readFrame(reader)).toBe(
      `event: snapshot\ndata: {"rows":[{"id":1,"body":"hi"}]}\nid: c0\n\n`,
    );

    src.fire(insert, "c1");
    expect(await readFrame(reader)).toBe(
      `event: change\ndata: {"op":"insert","key":"2","row":{"id":2,"body":"yo"}}\nid: c1\n\n`,
    );

    await reader.cancel();
    expect(src.close).toHaveBeenCalled();
  });

  it("heartbeats on the interval", async () => {
    const timers = fakeStreamTimers();
    const src = fakeSource();

    const stream = openShapeStream({
      source: src.source,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
    });
    const reader = stream.getReader();
    await readFrame(reader); // snapshot

    timers.intervalCbs[0]!(); // fire heartbeat
    expect(await readFrame(reader)).toBe(": ping\n\n");

    await reader.cancel();
  });

  it("tears down immediately if the client already disconnected", async () => {
    const timers = fakeStreamTimers();
    const src = fakeSource();
    const controller = new AbortController();
    controller.abort();

    const stream = openShapeStream({
      source: src.source,
      signal: controller.signal,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
    });
    const reader = stream.getReader();

    // No snapshot — the stream closed before emitting anything.
    expect(await readFrame(reader)).toBeUndefined();
    expect(src.close).toHaveBeenCalledTimes(1);
  });

  it("tears down on client disconnect mid-stream", async () => {
    const timers = fakeStreamTimers();
    const src = fakeSource();
    const controller = new AbortController();

    const stream = openShapeStream({
      source: src.source,
      signal: controller.signal,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
    });
    const reader = stream.getReader();
    await readFrame(reader); // snapshot

    controller.abort();
    expect(src.close).toHaveBeenCalledTimes(1);
    expect(timers.cleared).toHaveLength(1); // the heartbeat interval was cleared
    expect(await readFrame(reader)).toBeUndefined();
  });

  it("drops a slow client to a resync when its buffer overflows", async () => {
    const timers = fakeStreamTimers();
    const src = fakeSource();

    const stream = openShapeStream({
      source: src.source,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 1, // one unread frame fills the buffer
      timers: timers.seam,
    });
    const reader = stream.getReader();

    // Do NOT read the snapshot — the buffer is now full. The next change overflows.
    src.fire(insert, "c1");

    expect(await readFrame(reader)).toBe(
      `event: snapshot\ndata: {"rows":[{"id":1,"body":"hi"}]}\nid: c0\n\n`,
    );
    expect(await readFrame(reader)).toBe("event: resync\ndata: \nid: c1\n\n");
    expect(await readFrame(reader)).toBeUndefined(); // closed
    expect(src.close).toHaveBeenCalledTimes(1);
  });

  it("severs the stream when re-auth fails, and keeps it when re-auth passes", async () => {
    const timers = fakeStreamTimers();
    const src = fakeSource();
    let valid = true;

    const stream = openShapeStream({
      source: src.source,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
      revalidate: () => valid,
      reauthMs: 500,
    });
    const reader = stream.getReader();
    await readFrame(reader); // snapshot

    timers.intervalCbs[1]!(); // re-auth passes
    await flush();
    expect(src.close).not.toHaveBeenCalled();

    valid = false;
    timers.intervalCbs[1]!(); // re-auth fails → teardown
    timers.intervalCbs[1]!(); // a second firing re-enters teardown, which is idempotent
    await flush();
    expect(src.close).toHaveBeenCalledTimes(1); // torn once — the second teardown no-ops
    expect(await readFrame(reader)).toBeUndefined();
  });

  it("fails closed when re-auth throws", async () => {
    const timers = fakeStreamTimers();
    const src = fakeSource();

    const stream = openShapeStream({
      source: src.source,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
      revalidate: () => {
        throw new Error("auth backend down");
      },
    });
    const reader = stream.getReader();
    await readFrame(reader); // snapshot

    timers.intervalCbs[1]!();
    await flush();
    expect(src.close).toHaveBeenCalledTimes(1);
  });

  it("severs at the connection TTL", async () => {
    const timers = fakeStreamTimers();
    const src = fakeSource();

    const stream = openShapeStream({
      source: src.source,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
      maxConnectionMs: 5000,
    });
    const reader = stream.getReader();
    await readFrame(reader); // snapshot

    timers.timeoutCbs[0]!(); // TTL fires
    expect(src.close).toHaveBeenCalledTimes(1);
    expect(await readFrame(reader)).toBeUndefined();
  });

  it("tolerates a source close that throws during teardown", async () => {
    const timers = fakeStreamTimers();
    const src = fakeSource();
    (src.source.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("unsubscribe failed");
    });

    const stream = openShapeStream({
      source: src.source,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
    });
    const reader = stream.getReader();
    await readFrame(reader);

    await expect(reader.cancel()).resolves.toBeUndefined(); // no throw escapes teardown
  });
});

// ---------------------------------------------------------------------------
// createLiveDataHttpHandlers
// ---------------------------------------------------------------------------

describe("createLiveDataHttpHandlers", () => {
  const shapeParam = JSON.stringify(def);

  it("streams the snapshot for an authorized shape (200 + SSE headers)", async () => {
    const timers = fakeStreamTimers();
    const { liveData } = createLiveDataHttpHandlers({
      engine: engineReturning([{ id: 1, body: "hi" }]),
      resolvePrincipal: () => ({ id: "u1" }),
      authorizeShape: () => true,
      timers: timers.seam,
    });

    const response = await liveData(fakeContext({ shape: shapeParam }), noopNext);

    expect(response).toBeDefined();
    expect(response!.status).toBe(200);
    expect(response!.headers).toMatchObject({ "content-type": "text/event-stream" });

    const reader = (response!.body as ReadableStream<string>).getReader();
    expect(await readFrame(reader)).toContain(`"rows":[{"id":1,"body":"hi"}]`);
    await reader.cancel();
  });

  it("400s a missing shape parameter", async () => {
    const onDenied = vi.fn();
    const { liveData } = createLiveDataHttpHandlers({
      engine: engineReturning([]),
      resolvePrincipal: () => "u1",
      authorizeShape: () => true,
      onDenied,
    });

    const response = await liveData(fakeContext({}), noopNext);

    expect(response!.status).toBe(400);
    expect(JSON.parse(response!.body as string).error.code).toBe("LIVE_DATA_MISSING_SHAPE");
    expect(onDenied).toHaveBeenCalledWith("u1", "missing-shape");
  });

  it("400s a malformed shape parameter", async () => {
    const { liveData } = createLiveDataHttpHandlers({
      engine: engineReturning([]),
      resolvePrincipal: () => "u1",
      authorizeShape: () => true,
    });

    const response = await liveData(fakeContext({ shape: "{not-json" }), noopNext);

    expect(response!.status).toBe(400);
    expect(JSON.parse(response!.body as string).error.code).toBe("LIVE_DATA_INVALID_SHAPE");
  });

  it("403s an unauthorized shape", async () => {
    const onDenied = vi.fn();
    const { liveData } = createLiveDataHttpHandlers({
      engine: engineReturning([]),
      resolvePrincipal: () => "u1",
      authorizeShape: () => false,
      onDenied,
    });

    const response = await liveData(fakeContext({ shape: shapeParam }), noopNext);

    expect(response!.status).toBe(403);
    expect(JSON.parse(response!.body as string).error.code).toBe("LIVE_DATA_FORBIDDEN");
    expect(onDenied).toHaveBeenCalledWith("u1", "forbidden");
  });

  it("400s a registry error (unknown table) with its code, before opening a stream", async () => {
    const onDenied = vi.fn();
    const engine = {
      subscribe: async () => {
        throw new LiveServerError("LIVE_SERVER_UNKNOWN_TABLE", "no such table");
      },
      activeShapes: 0,
      stop: () => {},
    } as unknown as ShapeEngine;

    const { liveData } = createLiveDataHttpHandlers({
      engine,
      resolvePrincipal: () => "u1",
      authorizeShape: () => true,
      onDenied,
    });

    const response = await liveData(fakeContext({ shape: shapeParam }), noopNext);

    expect(response!.status).toBe(400);
    expect(JSON.parse(response!.body as string).error.code).toBe("LIVE_SERVER_UNKNOWN_TABLE");
    expect(onDenied).toHaveBeenCalledWith("u1", "LIVE_SERVER_UNKNOWN_TABLE");
  });

  it("rethrows an unexpected subscribe error (not a registry refusal)", async () => {
    const engine = {
      subscribe: async () => {
        throw new Error("database exploded");
      },
      activeShapes: 0,
      stop: () => {},
    } as unknown as ShapeEngine;

    const { liveData } = createLiveDataHttpHandlers({
      engine,
      resolvePrincipal: () => "u1",
      authorizeShape: () => true,
    });

    await expect(liveData(fakeContext({ shape: shapeParam }), noopNext)).rejects.toThrow(
      "database exploded",
    );
  });

  it("defaults to real, unref'd timers when none are injected", async () => {
    // No `timers`: the default seam's setInterval/setTimeout (both unref'd) register the
    // heartbeat + TTL, and clearInterval/clearTimeout run on cancel. The 30s heartbeat and
    // 5s TTL never fire in this fast test — this exercises the default wiring only.
    const { liveData } = createLiveDataHttpHandlers({
      engine: engineReturning([{ id: 1 }]),
      resolvePrincipal: () => "u1",
      authorizeShape: () => true,
      maxConnectionMs: 5000,
    });

    const response = await liveData(fakeContext({ shape: shapeParam }), noopNext);
    const reader = (response!.body as ReadableStream<string>).getReader();
    await readFrame(reader); // snapshot

    await reader.cancel(); // clears the real interval + timeout
    expect(response!.status).toBe(200);
  });

  it("plumbs revalidate/reauthMs/maxConnectionMs through to the stream", async () => {
    const timers = fakeStreamTimers();
    const revalidate = vi.fn(() => true);

    const { liveData } = createLiveDataHttpHandlers({
      engine: engineReturning([{ id: 1 }]),
      resolvePrincipal: () => "u1",
      authorizeShape: () => true,
      revalidate,
      reauthMs: 500,
      maxConnectionMs: 5000,
      timers: timers.seam,
    });

    const response = await liveData(fakeContext({ shape: shapeParam }), noopNext);
    const reader = (response!.body as ReadableStream<string>).getReader();
    await readFrame(reader); // snapshot

    // Heartbeat (i0) + revalidate (i1) intervals and a TTL timeout are all registered.
    expect(timers.intervalCbs).toHaveLength(2);
    expect(timers.timeoutCbs).toHaveLength(1);

    timers.intervalCbs[1]!(); // re-auth runs with the bound principal
    await flush();
    expect(revalidate).toHaveBeenCalledWith("u1");

    await reader.cancel();
  });
});
