import { describe, expect, it, vi } from "vitest";

import type { ShapeChange } from "@lesto/live-protocol";

import { ShapeConnection } from "../src/index";
import type { FrameController } from "../src/index";

/** A fake controller: records frames, exposes a mutable desiredSize, can throw on demand. */
function fakeController(options: { enqueueThrows?: boolean; closeThrows?: boolean } = {}) {
  const frames: string[] = [];
  const state = { desiredSize: 16 as number | null, closed: false };

  const controller: FrameController = {
    get desiredSize() {
      return state.desiredSize;
    },
    enqueue(frame) {
      if (options.enqueueThrows) throw new Error("enqueue failed");
      frames.push(frame);
    },
    close() {
      if (options.closeThrows) throw new Error("close failed");
      state.closed = true;
    },
  };

  return { controller, frames, state };
}

const insert: ShapeChange = { op: "insert", key: "1", row: { id: 1, body: "hi" } };

describe("ShapeConnection", () => {
  it("emits the snapshot frame at open", () => {
    const { controller, frames } = fakeController();
    const conn = new ShapeConnection({ controller, onOverflow: () => {} });

    conn.snapshot([{ id: 1, body: "hi" }], "c0");

    expect(frames).toEqual([`event: snapshot\ndata: {"rows":[{"id":1,"body":"hi"}]}\nid: c0\n\n`]);
  });

  it("emits a change frame when there is room", () => {
    const { controller, frames } = fakeController();
    const conn = new ShapeConnection({ controller, onOverflow: () => {} });

    conn.deliver(insert, "c1");

    expect(frames).toEqual([
      `event: change\ndata: {"op":"insert","key":"1","row":{"id":1,"body":"hi"}}\nid: c1\n\n`,
    ]);
  });

  it("emits a heartbeat comment", () => {
    const { controller, frames } = fakeController();
    const conn = new ShapeConnection({ controller, onOverflow: () => {} });

    conn.heartbeat();

    expect(frames).toEqual([": ping\n\n"]);
  });

  it("resync() emits a final resync frame and closes, WITHOUT signaling onOverflow", () => {
    // The public primitive the handler drives on de-authorization (ADR 0042 (c)/(d)) — distinct
    // from the internal overflow path, which additionally signals onOverflow so the handler tears
    // its own timers/subscription down. A revocation already runs its own teardown right after.
    const { controller, frames, state } = fakeController();
    const onOverflow = vi.fn();
    const conn = new ShapeConnection({ controller, onOverflow });

    conn.resync("c7");

    expect(frames).toEqual(["event: resync\ndata: \nid: c7\n\n"]);
    expect(conn.closed).toBe(true);
    expect(state.closed).toBe(true);
    expect(onOverflow).not.toHaveBeenCalled();
  });

  it("resync() is a no-op once already closed", () => {
    const { controller, frames } = fakeController();
    const conn = new ShapeConnection({ controller, onOverflow: () => {} });

    conn.close();
    conn.resync("c7");

    expect(frames).toEqual([]);
  });

  it("drops a slow client to a resync + close + onOverflow when the buffer is full", () => {
    const { controller, frames, state } = fakeController();
    const onOverflow = vi.fn();
    const conn = new ShapeConnection({ controller, onOverflow });

    state.desiredSize = 0; // high-water mark reached
    conn.deliver(insert, "c9");

    expect(frames).toEqual(["event: resync\ndata: \nid: c9\n\n"]);
    expect(conn.closed).toBe(true);
    expect(state.closed).toBe(true);
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it("treats a null desiredSize (errored/closed stream) as full", () => {
    const { controller, frames, state } = fakeController();
    const onOverflow = vi.fn();
    state.desiredSize = null;

    const conn = new ShapeConnection({ controller, onOverflow });
    conn.deliver(insert, "c9");

    expect(frames).toEqual(["event: resync\ndata: \nid: c9\n\n"]);
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it("is inert after close — snapshot / deliver / heartbeat all no-op", () => {
    const { controller, frames } = fakeController();
    const conn = new ShapeConnection({ controller, onOverflow: () => {} });

    conn.close();
    conn.snapshot([{ id: 1 }], "c0");
    conn.deliver(insert, "c1");
    conn.heartbeat();

    expect(frames).toEqual([]);
  });

  it("close is idempotent", () => {
    const { controller } = fakeController();
    const conn = new ShapeConnection({ controller, onOverflow: () => {} });

    conn.close();
    expect(() => conn.close()).not.toThrow();
    expect(conn.closed).toBe(true);
  });

  it("treats an enqueue that throws (racing teardown) as closed", () => {
    const { controller } = fakeController({ enqueueThrows: true });
    const conn = new ShapeConnection({ controller, onOverflow: () => {} });

    conn.snapshot([{ id: 1 }], "c0");

    expect(conn.closed).toBe(true);
  });

  it("tolerates a close that throws (stream already closed by the machinery)", () => {
    const { controller } = fakeController({ closeThrows: true });
    const conn = new ShapeConnection({ controller, onOverflow: () => {} });

    expect(() => conn.close()).not.toThrow();
    expect(conn.closed).toBe(true);
  });
});
