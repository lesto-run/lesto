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
import { encodeResumeCursor } from "../src/index";
import type {
  ResumeCursor,
  ShapeChangeListener,
  ShapeEngine,
  ShapeResume,
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

/** A shape bound to one concrete room id — the CONCRETE parameter, not a reusable template. */
function roomShape(roomId: number): ShapeDefinition {
  return {
    table: "messages",
    key: "id",
    columns: ["id", "roomId", "body"],
    where: [{ column: "roomId", op: "eq", value: roomId }],
    orderBy: undefined,
  };
}

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
function fakeSource(
  snapshot: readonly Row[] = [{ id: 1, body: "hi" }],
  cursor: Cursor = "c0",
  resume?: ShapeResume,
) {
  let deliver: ((change: ShapeChange, cursor: Cursor) => void) | undefined;
  const close = vi.fn();

  const source: ShapeStreamSource = {
    snapshot,
    cursor,
    ...(resume === undefined ? {} : { resume }),
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

/**
 * A stub engine that captures the change listener (so a test can fire changes by hand) and the
 * reconnect cursor the handler threaded in (so a test can assert `Last-Event-ID` was decoded).
 */
function stubEngine(): {
  engine: ShapeEngine;
  fire: ShapeChangeListener;
  unsub: () => void;
  since: () => ResumeCursor | undefined;
} {
  let captured: ShapeChangeListener | undefined;
  let capturedSince: ResumeCursor | undefined;
  const unsub = vi.fn();

  const engine = {
    subscribe: async (
      shape: ShapeDefinition,
      onChange: ShapeChangeListener,
      since?: ResumeCursor,
    ) => {
      captured = onChange;
      capturedSince = since;

      return {
        shapeId: shapeId(shape),
        snapshot: [{ id: 1 }],
        cursor: "c0",
        resume: { kind: "snapshot" } as ShapeResume,
        unsubscribe: unsub,
      };
    },
    activeShapes: 1,
    stop: () => {},
  } as ShapeEngine;

  return { engine, fire: (c, cur) => captured?.(c, cur), unsub, since: () => capturedSince };
}

/** A stub engine whose subscribe returns a fixed snapshot (and an optional resume decision). */
function engineReturning(
  snapshot: readonly Row[],
  resume: ShapeResume = { kind: "snapshot" },
): ShapeEngine {
  return {
    subscribe: async (shape: ShapeDefinition) => ({
      shapeId: shapeId(shape),
      snapshot,
      cursor: "c0",
      resume,
      unsubscribe: () => {},
    }),
    activeShapes: 1,
    stop: () => {},
  } as ShapeEngine;
}

/** A minimal fake context: query params + optional request headers + optional abort signal. */
function fakeContext(
  query: Record<string, string>,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Context {
  return {
    query: (name: string) => query[name],
    header: (name: string) => headers[name],
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

  it("on resume, replays ONLY the missed changes (no snapshot), then tails live changes (Inc4)", async () => {
    const timers = fakeStreamTimers();
    // A resuming client that proved continuity: the engine handed back a `replay`, not a snapshot.
    const missed: ShapeResume = {
      kind: "replay",
      changes: [{ change: insert, cursor: "v1:sysA:1:0/20" }],
    };
    const src = fakeSource([{ id: 1, body: "hi" }], "v1:sysA:1:0/10", missed);

    const stream = openShapeStream({
      source: src.source,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
    });
    const reader = stream.getReader();

    // The FIRST frame is the missed change, NOT a snapshot — the client keeps its local slice.
    expect(await readFrame(reader)).toBe(
      `event: change\ndata: {"op":"insert","key":"2","row":{"id":2,"body":"yo"}}\nid: v1:sysA:1:0/20\n\n`,
    );

    // Then the live tail flows through the same connection.
    src.fire({ op: "delete", key: "9" }, "v1:sysA:1:0/30");
    expect(await readFrame(reader)).toBe(
      `event: change\ndata: {"op":"delete","key":"9"}\nid: v1:sysA:1:0/30\n\n`,
    );

    await reader.cancel();
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
    timers.intervalCbs[1]!(); // re-auth fails → resync-purge, then teardown
    timers.intervalCbs[1]!(); // a second firing re-enters teardown, which is idempotent
    await flush();
    expect(src.close).toHaveBeenCalledTimes(1); // torn once — the second teardown no-ops
    // A failed re-auth must PURGE the client's durable slice, not merely close the socket —
    // else every row already delivered would sit stranded in the client's store.
    expect(await readFrame(reader)).toBe("event: resync\ndata: \nid: c0\n\n");
    expect(await readFrame(reader)).toBeUndefined(); // then closed
  });

  it("fails closed when re-auth throws — still purges before tearing down", async () => {
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
    expect(await readFrame(reader)).toBe("event: resync\ndata: \nid: c0\n\n");
  });

  it("stamps the resync-purge with the LAST DELIVERED cursor, not the stale snapshot cursor", async () => {
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
    await readFrame(reader); // snapshot at cursor "c0"

    src.fire({ op: "insert", key: "9", row: { id: 9 } }, "c1");
    await readFrame(reader); // the delivered change, at cursor "c1"

    valid = false;
    timers.intervalCbs[1]!(); // re-auth fails
    await flush();

    expect(await readFrame(reader)).toBe("event: resync\ndata: \nid: c1\n\n");
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

  it("decodes the Last-Event-ID header and threads the resume cursor to the engine (Inc4)", async () => {
    const stub = stubEngine();
    const { liveData } = createLiveDataHttpHandlers({
      engine: stub.engine,
      resolvePrincipal: () => "u1",
      authorizeShape: () => true,
    });

    const cursor: ResumeCursor = { systemId: "sysA", timelineId: 1, lsn: "0/20" };
    const response = await liveData(
      fakeContext({ shape: shapeParam }, undefined, {
        "last-event-id": encodeResumeCursor(cursor),
      }),
      noopNext,
    );

    expect(stub.since()).toEqual(cursor);
    await (response!.body as ReadableStream<string>).cancel();
  });

  it("falls back to ?lastEventId= for a non-EventSource client (Inc4)", async () => {
    const stub = stubEngine();
    const { liveData } = createLiveDataHttpHandlers({
      engine: stub.engine,
      resolvePrincipal: () => "u1",
      authorizeShape: () => true,
    });

    const cursor: ResumeCursor = { systemId: "sysA", timelineId: 7, lsn: "3/AB" };
    const response = await liveData(
      fakeContext({ shape: shapeParam, lastEventId: encodeResumeCursor(cursor) }),
      noopNext,
    );

    expect(stub.since()).toEqual(cursor);
    await (response!.body as ReadableStream<string>).cancel();
  });

  it("ignores a malformed resume cursor — the engine sees `undefined` (re-snapshot floor, Inc4)", async () => {
    const stub = stubEngine();
    const { liveData } = createLiveDataHttpHandlers({
      engine: stub.engine,
      resolvePrincipal: () => "u1",
      authorizeShape: () => true,
    });

    const response = await liveData(
      fakeContext({ shape: shapeParam }, undefined, { "last-event-id": "v0:5" }),
      noopNext,
    );

    expect(stub.since()).toBeUndefined();
    await (response!.body as ReadableStream<string>).cancel();
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

  it("re-auths the bound shape on the interval even when no app `revalidate` is supplied (ADR 0042 (a)/(c)/(d))", async () => {
    const timers = fakeStreamTimers();
    const authorizeShape = vi.fn(() => true);

    const { liveData } = createLiveDataHttpHandlers({
      engine: engineReturning([{ id: 1 }]),
      resolvePrincipal: () => "u1",
      authorizeShape,
      timers: timers.seam,
    });

    const response = await liveData(fakeContext({ shape: shapeParam }), noopNext);
    const reader = (response!.body as ReadableStream<string>).getReader();
    await readFrame(reader); // snapshot

    // The re-auth interval registers REGARDLESS of an app-supplied `revalidate` — the
    // always-on `authorizeShape` re-check is enough on its own.
    expect(timers.intervalCbs).toHaveLength(2); // heartbeat + re-auth
    expect(authorizeShape).toHaveBeenCalledTimes(1); // just the initial subscribe so far

    timers.intervalCbs[1]!();
    await flush();
    expect(authorizeShape).toHaveBeenCalledTimes(2); // re-checked on the tick

    await reader.cancel();
  });

  it("purges the client's slice and severs when authorizeShape starts refusing mid-connection (revoked cross-relation authz, ADR 0042 (c))", async () => {
    const timers = fakeStreamTimers();
    let authorized = true;

    const { liveData } = createLiveDataHttpHandlers({
      engine: engineReturning([{ id: 1 }]),
      resolvePrincipal: () => "u1",
      authorizeShape: () => authorized,
      timers: timers.seam,
    });

    const response = await liveData(fakeContext({ shape: shapeParam }), noopNext);
    const reader = (response!.body as ReadableStream<string>).getReader();
    await readFrame(reader); // snapshot

    // The principal's SESSION stays valid (no app `revalidate` is even supplied); only the
    // bound shape's authorization is revoked — e.g. removed from a room via a separate
    // membership relation the replication stream on this table cannot observe.
    authorized = false;
    timers.intervalCbs[1]!();
    await flush();

    expect(await readFrame(reader)).toBe("event: resync\ndata: \nid: c0\n\n");
    expect(await readFrame(reader)).toBeUndefined(); // then closed — never left open
  });
});

// ---------------------------------------------------------------------------
// ADR 0042 acceptance matrix — the Tier-4 v1 Inc3 gate (L-f50f94d1)
//
// Named, discoverable letter-by-letter (docs/adr/0042-local-first-sync-tier-4.md, the
// "Acceptance" section). (b) and (c)'s on-row case are proven at the classifier/engine layer
// (Inc2 + the L-08619e99 marker+column-presence fix) — cross-referenced below rather than
// duplicated. Everything reachable only through the HTTP handler (bound-parameter authz,
// continuous re-auth, reconnect safety) is proven here.
// ---------------------------------------------------------------------------

describe("ADR 0042 acceptance matrix — the Inc3 gate", () => {
  const shapeParam = JSON.stringify(def);

  // (b) delete-from-shape on a non-PK predicate under REPLICA IDENTITY FULL, plus
  // refuse-unsupported-shape: this module has no replication/classifier seam to exercise, so
  // this letter is satisfied entirely by the dedicated coverage in classify.test.ts
  // (assertOldImageComplete, prepareShapeClassifier's registration guard) and engine.test.ts
  // (the replication change-source suite) — proven end-to-end by the L-08619e99 marker +
  // column-presence guard. Not duplicated here.

  it("(a) refuses a shape whose BOUND parameter resolves to another tenant's resource — not merely the template", async () => {
    // Same table, same columns (the "template") for both requests — only the bound `roomId`
    // differs. `authorizeShape` here authorizes room 1 (the caller's own) and refuses room 999
    // (another tenant's): proof the check is on the concrete parameter, not "may this principal
    // use the messages shape at all" (which both requests would pass identically).
    const onDenied = vi.fn();
    const { liveData } = createLiveDataHttpHandlers({
      engine: engineReturning([{ id: 1, body: "hi" }]),
      resolvePrincipal: () => "u1",
      authorizeShape: (_, shape) => shape.where[0]?.value === 1,
      onDenied,
    });

    const ownRoom = await liveData(fakeContext({ shape: JSON.stringify(roomShape(1)) }), noopNext);
    expect(ownRoom!.status).toBe(200);

    const otherTenant = await liveData(
      fakeContext({ shape: JSON.stringify(roomShape(999)) }),
      noopNext,
    );
    expect(otherTenant!.status).toBe(403);
    expect(onDenied).toHaveBeenCalledWith("u1", "forbidden");
  });

  // (c) on-row case: an authorization column ON the streamed row (e.g. `owner_id`) leaving the
  // shape propagates SUB-INTERVAL as an ordinary delete-from-shape — see engine.test.ts's
  // "delivers a delete-from-shape when a row is updated OUT of the shape" (poll path) and
  // "delivers a delete-from-shape when a replication update moves a row OUT (the leak-stopper)"
  // (v1 replication path). No interval involved; not duplicated here.
  //
  // (c) cross-relation case: a membership change in a SEPARATE relation (a `room_members`-style
  // join) cannot be observed by the replication stream, so it is caught at the next re-auth
  // tick — proven above by "purges the client's slice and severs when authorizeShape starts
  // refusing mid-connection (revoked cross-relation authz, ADR 0042 (c))", which IS this
  // criterion's mechanism (mandatory `authorizeShape` re-invocation → resync-purge → teardown).

  it("(d) a revoked SESSION (bound shape still authorized) is severed within the re-auth interval, bounded by reauthMs", async () => {
    const timers = fakeStreamTimers();
    let sessionValid = true;

    const { liveData } = createLiveDataHttpHandlers({
      engine: engineReturning([{ id: 1 }]),
      resolvePrincipal: () => "u1",
      authorizeShape: () => true, // the bound shape stays authorized throughout
      revalidate: () => sessionValid, // only the SESSION is revoked
      reauthMs: 500,
      timers: timers.seam,
    });

    const response = await liveData(fakeContext({ shape: shapeParam }), noopNext);
    const reader = (response!.body as ReadableStream<string>).getReader();
    await readFrame(reader); // snapshot

    sessionValid = false; // e.g. logout / an admin killing the session
    timers.intervalCbs[1]!(); // the NEXT re-auth tick — no later than one `reauthMs`
    await flush();

    expect(await readFrame(reader)).toBe("event: resync\ndata: \nid: c0\n\n");
    expect(await readFrame(reader)).toBeUndefined(); // severed — bounded by a single interval
  });

  // (e) LSN-exact resume, now landed (Inc4, L-6841d65d). The replay-or-re-snapshot DECISION lives
  // in the engine + replay ring — proven in engine.test.ts's "LSN-exact resume" suite (replay of
  // exactly the missed changes; re-snapshot on a systemId mismatch, on a same-cluster
  // timelineId-incremented failover, and on an LSN aged past the retained window) and in resume.ts
  // (the ring unit tests). Here we prove the HTTP-handler wiring: the `Last-Event-ID` decode + thread
  // (the three "resume cursor" tests above), the replay SEND path (openShapeStream's "replays ONLY
  // the missed changes"), and — below — that a reconnect WITHOUT a resumable cursor still re-snapshots.

  it("(e) a reconnect without a resumable cursor re-subscribes to a FRESH, complete snapshot — a row deleted while disconnected never reappears", async () => {
    // Simulates "offline, then reconnect" with no Last-Event-ID (or a v0/aged cursor → the engine
    // returns `resume: snapshot`): the underlying data changed between two `liveData` calls for the
    // identical shape (id 2 was deleted while the client was away). The re-snapshot must be the FULL
    // current set — its `snapshot` frame REPLACES the client's slice — never a stale carry-over that
    // still includes the deleted row.
    let currentRows: Row[] = [
      { id: 1, body: "a" },
      { id: 2, body: "b" },
    ];
    const engine = {
      subscribe: async (shape: ShapeDefinition) => ({
        shapeId: shapeId(shape),
        snapshot: currentRows,
        cursor: "v0:0",
        resume: { kind: "snapshot" } as ShapeResume,
        unsubscribe: () => {},
      }),
      activeShapes: 1,
      stop: () => {},
    } as unknown as ShapeEngine;

    const { liveData } = createLiveDataHttpHandlers({
      engine,
      resolvePrincipal: () => "u1",
      authorizeShape: () => true,
    });

    const first = await liveData(fakeContext({ shape: shapeParam }), noopNext);
    const firstReader = (first!.body as ReadableStream<string>).getReader();
    expect(await readFrame(firstReader)).toContain(`"id":2`);
    await firstReader.cancel();

    currentRows = [{ id: 1, body: "a" }]; // id 2 deleted while "disconnected"

    const reconnect = await liveData(fakeContext({ shape: shapeParam }), noopNext);
    const reconnectReader = (reconnect!.body as ReadableStream<string>).getReader();
    const snapshotFrame = await readFrame(reconnectReader);

    expect(snapshotFrame).not.toContain(`"id":2`); // purged, not stale-carried
    expect(snapshotFrame).toContain(`"id":1`);
    await reconnectReader.cancel();
  });

  // (e) the opacity guard: the wire cursor is minted/parsed ONLY on the server — the poll path's
  // `v0:` counter (engine.test.ts) and Inc4's `v1:<systemId>:<timelineId>:<lsn>` token
  // (resume.test.ts's codec + the engine's cursor assertions). `@lesto/live`'s `consumer.ts` keeps
  // it opaque to the client: its `LiveMessageEvent` interface structurally excludes `id`/`lastEventId`
  // so the client cannot read it even if tempted (a compile error, not a convention) — the browser's
  // `EventSource` round-trips it as `Last-Event-ID` untouched. That opacity is what let Inc4's move
  // from `v0:` to a `(systemId, timelineId, LSN)` token be an ADDITIVE wire change, not a breaking one.
});
