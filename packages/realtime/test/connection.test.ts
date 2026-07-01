import { describe, expect, it } from "vitest";

import { LiveConnection } from "../src/connection";
import { ReplayRing } from "../src/replay-ring";
import type { FrameController } from "../src/connection";

/** A fake controller with a settable `desiredSize` so backpressure is driveable. */
class FakeController implements FrameController {
  frames: string[] = [];

  closeCount = 0;

  desiredSize: number | null = 10;

  /** When true, `enqueue`/`close` throw — simulating a stream torn down externally. */
  throwOnUse = false;

  enqueue(frame: string): void {
    if (this.throwOnUse) throw new TypeError("Controller is already closed");

    this.frames.push(frame);
  }

  close(): void {
    if (this.throwOnUse) throw new TypeError("Controller is already closed");

    this.closeCount += 1;
  }
}

/** A ring on `node-a` with two topics recorded (cursors `.1` and `.2`). */
function ringWith(...topics: string[]): ReplayRing {
  const ring = new ReplayRing({ instanceId: "node-a", maxEntries: 100, maxAgeMs: 60_000 });

  for (const topic of topics) ring.record(topic);

  return ring;
}

describe("LiveConnection.open", () => {
  it("emits nothing for a brand-new client (no resume cursor)", () => {
    const controller = new FakeController();
    const conn = new LiveConnection({ ring: ringWith(), controller, onOverflow: () => {} });

    conn.open(undefined, []);

    expect(controller.frames).toEqual([]);
  });

  it("replays exactly the missed topics when continuity is provable", () => {
    const ring = ringWith("a", "b");
    const controller = new FakeController();
    const conn = new LiveConnection({ ring, controller, onOverflow: () => {} });

    // A cursor from this node/generation at index 0 → topics a, b were missed.
    conn.open({ instanceId: "node-a", generation: 0, index: 0 }, ["a", "b"]);

    expect(controller.frames).toEqual([
      "event: invalidate\ndata: a\nid: node-a.0.2\n\n",
      "event: invalidate\ndata: b\nid: node-a.0.2\n\n",
    ]);
  });

  it("replays only the authorized topics — a reconnect never leaks another tenant's topic", () => {
    // Both topics share the ONE process-global ring, but this client is authorized
    // for org:1:posts only; org:2:secret must never be replayed to it.
    const ring = ringWith("org:1:posts", "org:2:secret");
    const controller = new FakeController();
    const conn = new LiveConnection({ ring, controller, onOverflow: () => {} });

    conn.open({ instanceId: "node-a", generation: 0, index: 0 }, ["org:1:posts"]);

    expect(controller.frames).toEqual(["event: invalidate\ndata: org:1:posts\nid: node-a.0.2\n\n"]);
  });

  it("resyncs when the cursor is from a different node", () => {
    const ring = ringWith("a", "b");
    const controller = new FakeController();
    const conn = new LiveConnection({ ring, controller, onOverflow: () => {} });

    conn.open({ instanceId: "other-node", generation: 0, index: 0 }, ["a", "b"]);

    expect(controller.frames).toEqual(["event: resync\ndata: \nid: node-a.0.2\n\n"]);
  });
});

describe("LiveConnection.deliver", () => {
  it("emits an invalidate frame with the delivered cursor", () => {
    const controller = new FakeController();
    const conn = new LiveConnection({ ring: ringWith(), controller, onOverflow: () => {} });

    conn.deliver("org:1:posts", { instanceId: "node-a", generation: 0, index: 7 });

    expect(controller.frames).toEqual(["event: invalidate\ndata: org:1:posts\nid: node-a.0.7\n\n"]);
  });

  it("is a no-op once closed", () => {
    const controller = new FakeController();
    const conn = new LiveConnection({ ring: ringWith(), controller, onOverflow: () => {} });

    conn.close();
    conn.deliver("a", { instanceId: "node-a", generation: 0, index: 1 });

    expect(controller.frames).toEqual([]);
  });

  it("drops a slow client to a resync and signals overflow when the buffer is full", () => {
    let overflowed = false;

    const controller = new FakeController();
    controller.desiredSize = 0; // the bounded buffer is exhausted

    const conn = new LiveConnection({
      ring: ringWith(),
      controller,
      onOverflow: () => (overflowed = true),
    });

    conn.deliver("a", { instanceId: "node-a", generation: 0, index: 9 });

    expect(controller.frames).toEqual(["event: resync\ndata: \nid: node-a.0.9\n\n"]);
    expect(controller.closeCount).toBe(1);
    expect(overflowed).toBe(true);
    expect(conn.closed).toBe(true);

    // A delivery after overflow is a no-op (already closed).
    conn.deliver("b", { instanceId: "node-a", generation: 0, index: 10 });
    expect(controller.frames).toHaveLength(1);
  });

  it("treats a null desiredSize (errored stream) as full", () => {
    let overflowed = false;

    const controller = new FakeController();
    controller.desiredSize = null;

    const conn = new LiveConnection({
      ring: ringWith(),
      controller,
      onOverflow: () => (overflowed = true),
    });

    conn.deliver("a", { instanceId: "node-a", generation: 0, index: 1 });

    expect(overflowed).toBe(true);
  });
});

describe("LiveConnection.heartbeat / close", () => {
  it("emits a ping comment, and nothing once closed", () => {
    const controller = new FakeController();
    const conn = new LiveConnection({ ring: ringWith(), controller, onOverflow: () => {} });

    conn.heartbeat();
    expect(controller.frames).toEqual([": ping\n\n"]);

    conn.close();
    conn.heartbeat();
    expect(controller.frames).toHaveLength(1);
  });

  it("closes the controller exactly once (idempotent)", () => {
    const controller = new FakeController();
    const conn = new LiveConnection({ ring: ringWith(), controller, onOverflow: () => {} });

    expect(conn.closed).toBe(false);

    conn.close();
    conn.close();

    expect(controller.closeCount).toBe(1);
    expect(conn.closed).toBe(true);
  });

  it("tolerates a controller torn down out from under it (enqueue / close throw)", () => {
    const controller = new FakeController();
    const conn = new LiveConnection({ ring: ringWith(), controller, onOverflow: () => {} });

    // The stream was cancelled/errored externally: a delivery's enqueue throws, but
    // the connection swallows it and marks itself closed rather than letting it escape.
    controller.throwOnUse = true;

    expect(() =>
      conn.deliver("a", { instanceId: "node-a", generation: 0, index: 1 }),
    ).not.toThrow();
    expect(conn.closed).toBe(true);

    // A fresh connection whose close() races an already-closed controller is also tolerant.
    const other = new FakeController();
    other.throwOnUse = true;
    const conn2 = new LiveConnection({ ring: ringWith(), controller: other, onOverflow: () => {} });

    expect(() => conn2.close()).not.toThrow();
    expect(conn2.closed).toBe(true);
  });
});
