import { describe, expect, it } from "vitest";

import { FanoutRoom, encodeFrame, parsePublishBody } from "../src/fanout";
import type { FanoutFrame, FanoutSocket } from "../src/fanout";
import { PubSub } from "../src/pubsub";

/** A socket that records every frame it is sent, for asserting receipt + order. */
class RecordingSocket implements FanoutSocket {
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  /** The decoded frames, for convenient assertions. */
  get frames(): FanoutFrame[] {
    return this.sent.map((raw) => JSON.parse(raw) as FanoutFrame);
  }
}

/** A socket whose `send` always throws — models a closed/errored connection. */
class ThrowingSocket implements FanoutSocket {
  calls = 0;

  send(): void {
    this.calls += 1;

    throw new Error("socket closed");
  }
}

describe("FanoutRoom", () => {
  it("fans a published message out to every subscriber on the channel", async () => {
    const room = new FanoutRoom();
    const a = new RecordingSocket();
    const b = new RecordingSocket();
    const c = new RecordingSocket();

    room.add(a, "news");
    room.add(b, "news");
    room.add(c, "news");

    const delivered = await room.publish("news", { headline: "hi" });

    expect(delivered).toBe(3);

    for (const socket of [a, b, c]) {
      expect(socket.frames).toEqual([
        { type: "message", channel: "news", seq: 1, data: { headline: "hi" } },
      ]);
    }
  });

  it("isolates channels — a subscriber only receives its own channel's messages", async () => {
    const room = new FanoutRoom();
    const news = new RecordingSocket();
    const sports = new RecordingSocket();

    room.add(news, "news");
    room.add(sports, "sports");

    expect(await room.publish("news", "n1")).toBe(1);

    expect(news.frames).toEqual([{ type: "message", channel: "news", seq: 1, data: "n1" }]);
    expect(sports.sent).toHaveLength(0);
  });

  it("the close thunk unsubscribes the socket — no further delivery", async () => {
    const room = new FanoutRoom();
    const socket = new RecordingSocket();

    const off = room.add(socket, "c");

    expect(room.subscriberCount("c")).toBe(1);

    off();

    expect(room.subscriberCount("c")).toBe(0);
    expect(await room.publish("c", "after-off")).toBe(0);
    expect(socket.sent).toHaveLength(0);
  });

  it("drops a socket whose send throws and still delivers to the rest (invariant 1)", async () => {
    const room = new FanoutRoom();
    const dead = new ThrowingSocket();
    const alive = new RecordingSocket();

    // `dead` is added FIRST, so if a throwing listener aborted the loop, `alive`
    // would never be reached — the strongest shape for this invariant.
    room.add(dead, "c");
    room.add(alive, "c");

    // The snapshot length is 2 even though `dead` threw and was dropped (invariant 3).
    expect(await room.publish("c", "one")).toBe(2);

    expect(dead.calls).toBe(1);
    expect(alive.frames).toEqual([{ type: "message", channel: "c", seq: 1, data: "one" }]);

    // `dead` self-unsubscribed on its throw, so it is gone from the next publish.
    expect(room.subscriberCount("c")).toBe(1);

    expect(await room.publish("c", "two")).toBe(1);

    expect(dead.calls).toBe(1);
    expect(alive.frames.map((f) => f.data)).toEqual(["one", "two"]);
  });

  it("publish returns the dispatched-subscriber count, 0 for an empty channel (invariant 3)", async () => {
    const room = new FanoutRoom();

    expect(await room.publish("empty", "x")).toBe(0);

    room.add(new RecordingSocket(), "c");
    room.add(new RecordingSocket(), "c");

    expect(await room.publish("c", "x")).toBe(2);
  });

  it("stamps a monotonic seq on each frame across publishes", async () => {
    const room = new FanoutRoom();
    const socket = new RecordingSocket();

    room.add(socket, "c");

    await room.publish("c", "a");
    await room.publish("c", "b");
    await room.publish("c", "c");

    expect(socket.frames.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it("operates on an injected hub when one is supplied", async () => {
    const hub = new PubSub();
    const room = new FanoutRoom({ hub });
    const socket = new RecordingSocket();

    room.add(socket, "shared");

    // `add` subscribed on the INJECTED hub, observable directly on it.
    expect(hub.subscriberCount("shared")).toBe(1);

    await room.publish("shared", { ok: true });

    expect(socket.frames).toEqual([
      { type: "message", channel: "shared", seq: 1, data: { ok: true } },
    ]);
  });
});

describe("encodeFrame", () => {
  it("round-trips a frame through JSON", () => {
    const frame: FanoutFrame = { type: "message", channel: "c", seq: 7, data: { nested: [1, 2] } };

    expect(JSON.parse(encodeFrame(frame))).toEqual(frame);
  });
});

describe("parsePublishBody", () => {
  it("accepts a non-empty channel with a present message (including null)", () => {
    expect(parsePublishBody({ channel: "c", message: { id: 1 } })).toEqual({
      channel: "c",
      message: { id: 1 },
    });

    expect(parsePublishBody({ channel: "c", message: null })).toEqual({
      channel: "c",
      message: null,
    });
  });

  it("rejects a non-object body", () => {
    expect(parsePublishBody("nope")).toBeUndefined();
  });

  it("rejects null", () => {
    expect(parsePublishBody(null)).toBeUndefined();
  });

  it("rejects a non-string channel", () => {
    expect(parsePublishBody({ channel: 42, message: "x" })).toBeUndefined();
  });

  it("rejects an empty-string channel", () => {
    expect(parsePublishBody({ channel: "", message: "x" })).toBeUndefined();
  });

  it("rejects a body missing the message key", () => {
    expect(parsePublishBody({ channel: "c" })).toBeUndefined();
  });
});
