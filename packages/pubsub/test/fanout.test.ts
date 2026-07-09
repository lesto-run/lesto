import { describe, expect, it } from "vitest";

import { FanoutRegistry, encodeFrame, fanout, parsePublishBody } from "../src/fanout";
import type { FanoutFrame, FanoutSocket } from "../src/fanout";

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

/** A socket reporting a fixed `bufferedAmount` (or none) — models a slow/fast consumer for the bound. */
class BufferedSocket implements FanoutSocket {
  readonly sent: string[] = [];

  // Only set when provided, so an unspecified `bufferedAmount` is genuinely absent (an
  // opaque transport) rather than a present `undefined` (exactOptionalPropertyTypes).
  readonly bufferedAmount?: number;

  constructor(bufferedAmount?: number) {
    if (bufferedAmount !== undefined) {
      this.bufferedAmount = bufferedAmount;
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

/** A frame stamped with `seq` by the caller (the seq counter lives outside the core). */
function frame(channel: string, seq: number, data: unknown): FanoutFrame {
  return { type: "message", channel, seq, data };
}

describe("fanout", () => {
  it("writes one frame to every socket and counts them delivered", () => {
    const a = new RecordingSocket();
    const b = new RecordingSocket();
    const c = new RecordingSocket();

    const result = fanout([a, b, c], frame("news", 1, { headline: "hi" }));

    expect(result).toEqual({ delivered: 3, failed: [] });

    for (const socket of [a, b, c]) {
      expect(socket.frames).toEqual([
        { type: "message", channel: "news", seq: 1, data: { headline: "hi" } },
      ]);
    }
  });

  it("returns delivered 0 for an empty socket list", () => {
    expect(fanout([], frame("news", 1, "x"))).toEqual({ delivered: 0, failed: [] });
  });

  it("drops a socket whose send throws, still delivers to the rest, and reports it in failed (invariant 1)", () => {
    const dead = new ThrowingSocket();
    const alive = new RecordingSocket();

    // `dead` is FIRST, so if a thrower aborted the loop, `alive` would never be
    // reached — the strongest shape for the invariant.
    const result = fanout([dead, alive], frame("c", 1, "one"));

    // `delivered` counts successes ONLY; the thrower is excluded and returned in `failed`.
    expect(result.delivered).toBe(1);
    expect(result.failed).toEqual([dead]);
    expect(dead.calls).toBe(1);
    expect(alive.frames).toEqual([{ type: "message", channel: "c", seq: 1, data: "one" }]);
  });
});

describe("fanout — backpressure (maxBufferedBytes)", () => {
  it("skips a socket over the buffer bound, reports it in failed, and never calls its send", () => {
    const slow = new BufferedSocket(200);
    const fast = new BufferedSocket(0);

    // `slow` is FIRST, so the over-bound skip must not abort delivery to `fast`.
    const result = fanout([slow, fast], frame("c", 1, "x"), { maxBufferedBytes: 100 });

    expect(result.delivered).toBe(1);
    expect(result.failed).toEqual([slow]);
    expect(slow.sent).toEqual([]); // over the bound → skipped, not buffered further
    expect(fast.sent).toHaveLength(1);
  });

  it("delivers to a socket AT the bound — the check is strictly greater-than", () => {
    const atBound = new BufferedSocket(100);

    const result = fanout([atBound], frame("c", 1, "x"), { maxBufferedBytes: 100 });

    expect(result.delivered).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it("cannot bound a socket that does not report bufferedAmount — it is always sent to", () => {
    const opaque = new BufferedSocket(undefined);

    const result = fanout([opaque], frame("c", 1, "x"), { maxBufferedBytes: 100 });

    expect(result.delivered).toBe(1);
    expect(opaque.sent).toHaveLength(1);
  });

  it("enforces no bound when maxBufferedBytes is omitted, even for a high bufferedAmount", () => {
    const wouldOverflow = new BufferedSocket(1_000_000);

    const result = fanout([wouldOverflow], frame("c", 1, "x"));

    expect(result.delivered).toBe(1);
    expect(wouldOverflow.sent).toHaveLength(1);
  });
});

describe("FanoutRegistry", () => {
  it("fans a frame out to every socket subscribed to a channel via socketsFor", () => {
    const registry = new FanoutRegistry();
    const a = new RecordingSocket();
    const b = new RecordingSocket();

    registry.add("news", a);
    registry.add("news", b);

    const result = fanout(registry.socketsFor("news"), frame("news", 1, "n1"));

    expect(result.delivered).toBe(2);
    expect(a.frames).toEqual([{ type: "message", channel: "news", seq: 1, data: "n1" }]);
    expect(b.sent).toHaveLength(1);
  });

  it("isolates channels — socketsFor returns only that channel's sockets", () => {
    const registry = new FanoutRegistry();
    const news = new RecordingSocket();

    registry.add("news", news);

    expect(registry.subscriberCount("news")).toBe(1);
    expect([...registry.socketsFor("sports")]).toEqual([]);
    expect(registry.subscriberCount("sports")).toBe(0);

    fanout(registry.socketsFor("sports"), frame("sports", 1, "goal"));

    expect(news.sent).toHaveLength(0);
  });

  it("the add thunk drops the socket — socketsFor no longer yields it", () => {
    const registry = new FanoutRegistry();
    const socket = new RecordingSocket();

    const off = registry.add("c", socket);

    expect(registry.subscriberCount("c")).toBe(1);

    off();

    expect(registry.subscriberCount("c")).toBe(0);
    expect([...registry.socketsFor("c")]).toEqual([]);
  });

  it("drop is idempotent and a no-op on an unknown channel", () => {
    const registry = new FanoutRegistry();
    const a = new RecordingSocket();
    const b = new RecordingSocket();

    registry.add("c", a);
    registry.add("c", b);

    // Dropping one leaves the other (channel not emptied).
    registry.drop("c", a);
    expect(registry.subscriberCount("c")).toBe(1);

    // Dropping a socket that isn't there, and a channel that doesn't exist — both no-ops.
    registry.drop("c", a);
    registry.drop("nonexistent", a);
    expect(registry.subscriberCount("c")).toBe(1);

    // Dropping the last empties (and deletes) the channel.
    registry.drop("c", b);
    expect(registry.subscriberCount("c")).toBe(0);
  });
});

describe("encodeFrame", () => {
  it("round-trips a frame through JSON", () => {
    const f: FanoutFrame = { type: "message", channel: "c", seq: 7, data: { nested: [1, 2] } };

    expect(JSON.parse(encodeFrame(f))).toEqual(f);
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
