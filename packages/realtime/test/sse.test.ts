import { describe, expect, it } from "vitest";

import {
  commentFrame,
  decodeCursor,
  encodeCursor,
  invalidateFrame,
  parseTopics,
  resyncFrame,
} from "../src/sse";

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a cursor through the SSE id token", () => {
    const cursor = { instanceId: "node-a", generation: 3, index: 17 };

    const token = encodeCursor(cursor);

    expect(token).toBe("node-a.3.17");
    expect(decodeCursor(token)).toEqual(cursor);
  });

  it("preserves an instanceId that itself contains a dot (parsed from the right)", () => {
    const cursor = { instanceId: "a.b.c", generation: 0, index: 0 };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("rejects an absent, short, or malformed token (forcing a resync)", () => {
    expect(decodeCursor(undefined)).toBeUndefined();
    // Fewer than three dot-separated parts.
    expect(decodeCursor("only.two")).toBeUndefined();
    // Empty instanceId.
    expect(decodeCursor(".0.0")).toBeUndefined();
    // Non-integer generation / index.
    expect(decodeCursor("n.x.0")).toBeUndefined();
    expect(decodeCursor("n.0.y")).toBeUndefined();
    // Negative position.
    expect(decodeCursor("n.-1.0")).toBeUndefined();
    expect(decodeCursor("n.0.-1")).toBeUndefined();
  });
});

describe("frame formatters", () => {
  it("formats an invalidate frame with the topic and cursor id", () => {
    expect(invalidateFrame("org:1:posts", "n.0.5")).toBe(
      "event: invalidate\ndata: org:1:posts\nid: n.0.5\n\n",
    );
  });

  it("formats a resync frame carrying the current cursor", () => {
    expect(resyncFrame("n.2.0")).toBe("event: resync\ndata: \nid: n.2.0\n\n");
  });

  it("formats a comment (heartbeat) frame", () => {
    expect(commentFrame("ping")).toBe(": ping\n\n");
  });
});

describe("parseTopics", () => {
  it("splits, trims, drops blanks, and dedupes", () => {
    expect(parseTopics("a, b ,a,, c")).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list for absent or all-blank input", () => {
    expect(parseTopics(undefined)).toEqual([]);
    expect(parseTopics("  , ,")).toEqual([]);
  });
});
