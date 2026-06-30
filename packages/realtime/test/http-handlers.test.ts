import { describe, expect, it, vi } from "vitest";

import { PubSub } from "@lesto/pubsub";
import type { Context, Handler, LestoResponse } from "@lesto/web";

import { createRealtimeHttpHandlers, openLiveStream } from "../src/http-handlers";
import { ReplayRing } from "../src/replay-ring";
import type { TimerSeam } from "../src/http-handlers";
import type { Cursor } from "../src/replay-ring";

/** Call the realtime `live` handler (which ignores `next`) and narrow its stream response. */
async function callLive(live: Handler, c: Context): Promise<LestoResponse<ReadableStream>> {
  const response = await live(c, (async () => undefined) as never);

  return response as LestoResponse<ReadableStream>;
}

/** A driveable timer seam: tests fire the captured interval/timeout callbacks by hand. */
function fakeTimers(): {
  seam: TimerSeam;
  intervals: Array<{ cb: () => void; ms: number }>;
  timeouts: Array<{ cb: () => void; ms: number }>;
} {
  const intervals: Array<{ cb: () => void; ms: number }> = [];
  const timeouts: Array<{ cb: () => void; ms: number }> = [];

  return {
    intervals,
    timeouts,
    seam: {
      setInterval: (cb, ms) => {
        const handle = { cb, ms };
        intervals.push(handle);

        return handle;
      },
      clearInterval: (handle) => {
        const i = intervals.indexOf(handle as { cb: () => void; ms: number });
        if (i >= 0) intervals.splice(i, 1);
      },
      setTimeout: (cb, ms) => {
        const handle = { cb, ms };
        timeouts.push(handle);

        return handle;
      },
      clearTimeout: (handle) => {
        const i = timeouts.indexOf(handle as { cb: () => void; ms: number });
        if (i >= 0) timeouts.splice(i, 1);
      },
    },
  };
}

/** Read every frame currently buffered in the stream (until it would block or close). */
async function drain(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const frames: string[] = [];

  try {
    // Race each read against a microtask so a still-open (empty) stream stops the drain.
    for (;;) {
      const next = await Promise.race([
        reader.read(),
        Promise.resolve().then(() => "idle" as const),
      ]);

      if (next === "idle") break;
      if (next.done) break;

      frames.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  return frames;
}

const ring = (instanceId = "node-a"): ReplayRing =>
  new ReplayRing({ instanceId, maxEntries: 100, maxAgeMs: 60_000 });

describe("openLiveStream", () => {
  it("subscribes authorized topics and delivers invalidate frames as the hub publishes", async () => {
    const hub = new PubSub();
    const r = ring();
    const timers = fakeTimers();
    const signal = new AbortController().signal;

    const stream = openLiveStream({
      hub,
      ring: r,
      authorizedTopics: ["org:1:posts"],
      since: undefined,
      signal,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
    });

    // The hub message IS the ring-assigned cursor.
    const cursor: Cursor = { instanceId: "node-a", generation: 0, index: 4 };
    await hub.publish("org:1:posts", cursor);

    expect(await drain(stream)).toEqual([
      "event: invalidate\ndata: org:1:posts\nid: node-a.0.4\n\n",
    ]);

    // A topic the connection did not subscribe to is not delivered.
    await hub.publish("org:1:other", cursor);
    expect(await drain(stream)).toEqual([]);
  });

  it("emits the initial resync/replay for a resume cursor", async () => {
    const hub = new PubSub();
    const r = ring();
    r.record("a");
    r.record("b");

    const stream = openLiveStream({
      hub,
      ring: r,
      authorizedTopics: [],
      since: { instanceId: "node-a", generation: 0, index: 0 },
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: fakeTimers().seam,
    });

    expect(await drain(stream)).toEqual([
      "event: invalidate\ndata: a\nid: node-a.0.2\n\n",
      "event: invalidate\ndata: b\nid: node-a.0.2\n\n",
    ]);
  });

  it("heart-beats on the interval", async () => {
    const hub = new PubSub();
    const timers = fakeTimers();

    const stream = openLiveStream({
      hub,
      ring: ring(),
      authorizedTopics: [],
      since: undefined,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
    });

    // Fire the heartbeat interval; a ping comment is enqueued.
    timers.intervals[0]!.cb();

    expect(await drain(stream)).toEqual([": ping\n\n"]);
  });

  it("tears down on client disconnect — unsubscribes the hub and clears timers", async () => {
    const hub = new PubSub();
    const timers = fakeTimers();
    const aborter = new AbortController();

    openLiveStream({
      hub,
      ring: ring(),
      authorizedTopics: ["t"],
      since: undefined,
      signal: aborter.signal,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
    });

    expect(hub.subscriberCount("t")).toBe(1);
    expect(timers.intervals).toHaveLength(1);

    aborter.abort();

    expect(hub.subscriberCount("t")).toBe(0);
    expect(timers.intervals).toHaveLength(0);
  });

  it("tears down at once if the signal was already aborted before setup", () => {
    const hub = new PubSub();
    const timers = fakeTimers();
    const aborter = new AbortController();
    aborter.abort();

    openLiveStream({
      hub,
      ring: ring(),
      authorizedTopics: ["t"],
      since: undefined,
      signal: aborter.signal,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
    });

    // Never subscribed, never armed a timer.
    expect(hub.subscriberCount("t")).toBe(0);
    expect(timers.intervals).toHaveLength(0);
  });

  it("tears down when the consumer cancels the stream", async () => {
    const hub = new PubSub();
    const timers = fakeTimers();

    const stream = openLiveStream({
      hub,
      ring: ring(),
      authorizedTopics: ["t"],
      since: undefined,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
    });

    expect(hub.subscriberCount("t")).toBe(1);

    await stream.cancel();

    expect(hub.subscriberCount("t")).toBe(0);
    expect(timers.intervals).toHaveLength(0);
  });

  it("drops a slow client to a resync and tears down on backpressure overflow", async () => {
    const hub = new PubSub();
    const timers = fakeTimers();
    const cursor: Cursor = { instanceId: "node-a", generation: 0, index: 1 };

    const stream = openLiveStream({
      hub,
      ring: ring(),
      authorizedTopics: ["t"],
      since: undefined,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 2, // tiny buffer: the 3rd undrained delivery overflows
      timers: timers.seam,
    });

    // Fill the buffer (no reads), then overflow.
    await hub.publish("t", cursor);
    await hub.publish("t", cursor);
    await hub.publish("t", cursor);

    // The subscription was torn down on overflow.
    expect(hub.subscriberCount("t")).toBe(0);
    expect(timers.intervals).toHaveLength(0);

    // The buffered frames end with a resync (the slow-client signal).
    const frames = await drain(stream);
    expect(frames.at(-1)).toBe("event: resync\ndata: \nid: node-a.0.1\n\n");
  });

  it("severs the stream when periodic re-auth fails, and bounds the lifetime by a TTL", async () => {
    const hub = new PubSub();
    const timers = fakeTimers();

    openLiveStream({
      hub,
      ring: ring(),
      authorizedTopics: ["t"],
      since: undefined,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
      revalidate: () => false, // session no longer valid
      reauthMs: 5000,
      maxConnectionMs: 60_000,
    });

    expect(hub.subscriberCount("t")).toBe(1);
    // Intervals: [heartbeat, reauth]; timeouts: [ttl].
    expect(timers.intervals).toHaveLength(2);
    expect(timers.timeouts).toHaveLength(1);

    // Fire the re-auth interval; the failing check severs the stream.
    timers.intervals[1]!.cb();
    await Promise.resolve();

    expect(hub.subscriberCount("t")).toBe(0);
  });

  it("keeps the stream alive when periodic re-auth passes", async () => {
    const hub = new PubSub();
    const timers = fakeTimers();

    openLiveStream({
      hub,
      ring: ring(),
      authorizedTopics: ["t"],
      since: undefined,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
      revalidate: () => true,
    });

    timers.intervals[1]!.cb();
    await Promise.resolve();
    await Promise.resolve();

    expect(hub.subscriberCount("t")).toBe(1);
  });

  it("is idempotent across two teardown triggers (the TTL fires after a disconnect)", () => {
    const hub = new PubSub();
    const timers = fakeTimers();
    const aborter = new AbortController();

    openLiveStream({
      hub,
      ring: ring(),
      authorizedTopics: ["t"],
      since: undefined,
      signal: aborter.signal,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
      maxConnectionMs: 30_000,
    });

    // Capture the TTL callback before teardown splices it from the fake-timer array.
    const ttlCb = timers.timeouts[0]!.cb;

    // First teardown via disconnect…
    aborter.abort();
    expect(hub.subscriberCount("t")).toBe(0);

    // …then the (already-cleared) TTL callback still fires once more — the second
    // teardown is a no-op (the idempotency guard), neither throwing nor re-clearing.
    expect(() => ttlCb()).not.toThrow();
    expect(hub.subscriberCount("t")).toBe(0);
  });

  it("severs the stream when the TTL fires", async () => {
    const hub = new PubSub();
    const timers = fakeTimers();

    openLiveStream({
      hub,
      ring: ring(),
      authorizedTopics: ["t"],
      since: undefined,
      signal: undefined,
      heartbeatMs: 1000,
      maxQueue: 16,
      timers: timers.seam,
      maxConnectionMs: 30_000,
    });

    expect(timers.timeouts).toHaveLength(1);
    timers.timeouts[0]!.cb();

    expect(hub.subscriberCount("t")).toBe(0);
  });
});

/** A minimal fake handler context exposing the slice the live handler reads. */
function fakeContext(options: {
  query?: Record<string, string>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Context {
  return {
    query: (name: string) => options.query?.[name],
    header: (name: string) => options.headers?.[name.toLowerCase()],
    signal: options.signal,
  } as unknown as Context;
}

describe("createRealtimeHttpHandlers", () => {
  it("opens an authorized SSE stream, dropping unauthorized topics", async () => {
    const hub = new PubSub();
    const onDropped = vi.fn();

    const { live } = createRealtimeHttpHandlers<{ org: string }>({
      hub,
      ring: ring(),
      resolvePrincipal: () => ({ org: "1" }),
      authorizeTopic: (p, topic) => topic.startsWith(`org:${p.org}:`),
      onDropped,
      timers: fakeTimers().seam,
    });

    const response = await callLive(
      live,
      fakeContext({ query: { topics: "org:1:posts,org:2:secret" } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(response.body).toBeInstanceOf(ReadableStream);

    // The unauthorized topic was dropped (and surfaced), the authorized one subscribed.
    expect(onDropped).toHaveBeenCalledWith({ org: "1" }, ["org:2:secret"]);
    expect(hub.subscriberCount("org:1:posts")).toBe(1);
    expect(hub.subscriberCount("org:2:secret")).toBe(0);
  });

  it("resumes from a Last-Event-ID header, then an explicit lastEventId query", async () => {
    const r = ring();
    r.record("a");

    const { live } = createRealtimeHttpHandlers({
      hub: new PubSub(),
      ring: r,
      resolvePrincipal: () => ({}),
      authorizeTopic: () => true,
      timers: fakeTimers().seam,
    });

    // Header path: a cursor at index 0 → topic "a" was missed → an invalidate frame.
    const fromHeader = await callLive(
      live,
      fakeContext({ headers: { "last-event-id": "node-a.0.0" } }),
    );
    const headerFrames = await drain(fromHeader.body as ReadableStream<string>);
    expect(headerFrames).toEqual(["event: invalidate\ndata: a\nid: node-a.0.1\n\n"]);

    // Query fallback when no header: an unparseable/foreign cursor → resync.
    const fromQuery = await callLive(live, fakeContext({ query: { lastEventId: "other.0.0" } }));
    const queryFrames = await drain(fromQuery.body as ReadableStream<string>);
    expect(queryFrames).toEqual(["event: resync\ndata: \nid: node-a.0.1\n\n"]);
  });

  it("arms and clears REAL timers when none are injected", async () => {
    const hub = new PubSub();
    const aborter = new AbortController();

    // No `timers` → the default real, unref'd timer seam is used for the heartbeat,
    // the re-auth interval, and the TTL timeout; aborting clears all three (no leak).
    const { live } = createRealtimeHttpHandlers({
      hub,
      ring: ring(),
      resolvePrincipal: () => ({}),
      authorizeTopic: () => true,
      revalidate: () => true,
      reauthMs: 60_000,
      maxConnectionMs: 120_000,
    });

    await callLive(live, fakeContext({ query: { topics: "t" }, signal: aborter.signal }));

    expect(hub.subscriberCount("t")).toBe(1);

    aborter.abort();
    expect(hub.subscriberCount("t")).toBe(0);
  });

  it("threads the revalidate / reauthMs / maxConnectionMs options into the stream", async () => {
    const hub = new PubSub();
    const timers = fakeTimers();
    const revalidate = vi.fn(() => true);

    const { live } = createRealtimeHttpHandlers<{ id: string }>({
      hub,
      ring: ring(),
      resolvePrincipal: () => ({ id: "u1" }),
      authorizeTopic: () => true,
      revalidate,
      reauthMs: 1234,
      maxConnectionMs: 9999,
      timers: timers.seam,
    });

    await callLive(live, fakeContext({ query: { topics: "t" } }));

    // Heartbeat + reauth intervals, and the TTL timeout, were all armed.
    expect(timers.intervals).toHaveLength(2);
    expect(timers.intervals[1]!.ms).toBe(1234);
    expect(timers.timeouts).toHaveLength(1);
    expect(timers.timeouts[0]!.ms).toBe(9999);

    // The re-auth closure is bound to the resolved principal.
    timers.intervals[1]!.cb();
    await Promise.resolve();
    expect(revalidate).toHaveBeenCalledWith({ id: "u1" });
  });
});
