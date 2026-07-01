import { describe, expect, it } from "vitest";

import {
  changeFrame,
  commentFrame,
  decodeChangeData,
  decodeSnapshotData,
  isValidCursor,
  LiveProtocolError,
  resyncFrame,
  snapshotFrame,
} from "../src/index";
import type { ShapeChange } from "../src/index";

/** Pull the `data:` payload out of a single-event SSE frame. */
function dataOf(frame: string): string {
  const line = frame.split("\n").find((l) => l.startsWith("data: "));

  return line === undefined ? "" : line.slice("data: ".length);
}

describe("isValidCursor", () => {
  it("accepts a non-empty single-line token", () => {
    expect(isValidCursor("lsn-42")).toBe(true);
  });

  it("rejects empty or multi-line tokens", () => {
    expect(isValidCursor("")).toBe(false);
    expect(isValidCursor("a\nb")).toBe(false);
    expect(isValidCursor("a\rb")).toBe(false);
  });
});

describe("encoders", () => {
  it("snapshotFrame carries the rows and cursor as one SSE event", () => {
    const frame = snapshotFrame([{ id: 1, body: "hi" }], "c1");

    expect(frame).toBe(`event: snapshot\ndata: {"rows":[{"id":1,"body":"hi"}]}\nid: c1\n\n`);
    expect(decodeSnapshotData(dataOf(frame)).rows).toEqual([{ id: 1, body: "hi" }]);
  });

  it("changeFrame carries an insert / update / delete", () => {
    const insert: ShapeChange = { op: "insert", key: "1", row: { id: 1 } };

    expect(changeFrame(insert, "c2")).toBe(
      `event: change\ndata: {"op":"insert","key":"1","row":{"id":1}}\nid: c2\n\n`,
    );
    expect(changeFrame({ op: "delete", key: "1" }, "c3")).toBe(
      `event: change\ndata: {"op":"delete","key":"1"}\nid: c3\n\n`,
    );
  });

  it("resyncFrame carries only the cursor", () => {
    expect(resyncFrame("c4")).toBe("event: resync\ndata: \nid: c4\n\n");
  });

  it("commentFrame is an SSE comment (the heartbeat)", () => {
    expect(commentFrame("ping")).toBe(": ping\n\n");
  });

  it("every row-data encoder rejects a newline-bearing cursor", () => {
    for (const encode of [
      () => snapshotFrame([], "bad\ncursor"),
      () => changeFrame({ op: "delete", key: "1" }, "bad\ncursor"),
      () => resyncFrame("bad\ncursor"),
    ]) {
      expect(encode).toThrow(LiveProtocolError);
      try {
        encode();
      } catch (error) {
        expect((error as LiveProtocolError).code).toBe("LIVE_PROTOCOL_MALFORMED_FRAME");
      }
    }
  });
});

describe("decodeSnapshotData", () => {
  it("decodes rows", () => {
    expect(decodeSnapshotData('{"rows":[{"id":1},{"id":2}]}').rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(decodeSnapshotData('{"rows":[]}').rows).toEqual([]);
  });

  const bad: Array<[string, string]> = [
    ["invalid JSON", "{nope"],
    ["a JSON array", "[]"],
    ["a JSON scalar", "42"],
    ["JSON null", "null"],
    ["a missing rows array", '{"rows":5}'],
    ["a row that is not an object", '{"rows":[1]}'],
    ["a row that is an array", '{"rows":[[]]}'],
    ["a row that is null", '{"rows":[null]}'],
  ];

  it.each(bad)("rejects %s", (_label, data) => {
    expect(() => decodeSnapshotData(data)).toThrow(LiveProtocolError);
    try {
      decodeSnapshotData(data);
    } catch (error) {
      expect((error as LiveProtocolError).code).toBe("LIVE_PROTOCOL_MALFORMED_FRAME");
    }
  });
});

describe("decodeChangeData", () => {
  it("decodes insert / update / delete", () => {
    expect(decodeChangeData('{"op":"insert","key":"1","row":{"id":1}}')).toEqual({
      op: "insert",
      key: "1",
      row: { id: 1 },
    });
    expect(decodeChangeData('{"op":"update","key":"1","row":{"id":1,"body":"x"}}')).toEqual({
      op: "update",
      key: "1",
      row: { id: 1, body: "x" },
    });
    expect(decodeChangeData('{"op":"delete","key":"1"}')).toEqual({ op: "delete", key: "1" });
  });

  const bad: Array<[string, string]> = [
    ["invalid JSON", "{nope"],
    ["a non-object", "[]"],
    ["a missing key", '{"op":"delete"}'],
    ["a non-string key", '{"op":"delete","key":5}'],
    ["an unknown op", '{"op":"upsert","key":"1"}'],
    ["an insert with no row", '{"op":"insert","key":"1"}'],
    ["an update with a non-object row", '{"op":"update","key":"1","row":5}'],
  ];

  it.each(bad)("rejects %s", (_label, data) => {
    expect(() => decodeChangeData(data)).toThrow(LiveProtocolError);
    try {
      decodeChangeData(data);
    } catch (error) {
      expect((error as LiveProtocolError).code).toBe("LIVE_PROTOCOL_MALFORMED_FRAME");
    }
  });
});
