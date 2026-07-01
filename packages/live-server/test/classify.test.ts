import { validateShapeDefinition } from "@lesto/live-protocol";
import type { Row, ShapeDefinition } from "@lesto/live-protocol";
import { describe, expect, it } from "vitest";

import {
  assertReplicaIdentity,
  classifyChange,
  predicateNeedsOldImage,
  LiveServerError,
} from "../src/index";
import type { ImageCoercer } from "../src/index";
import type { ReplicationChange, RowImage } from "../src/replication";

// A shape over `messages(id pk, room_id, body)`, filtering the NON-key column room_id = 1.
const shape = (where: ShapeDefinition["where"] = [{ column: "room_id", op: "eq", value: 1 }]) =>
  validateShapeDefinition({
    table: "messages",
    key: "id",
    columns: ["id", "room_id", "body"],
    where,
    orderBy: undefined,
  });

// A coercer standing in for the engine's `@lesto/db`-backed one: project the shape's columns and
// coerce pgoutput's text integers to numbers (the real coercer keys off the column kind).
const coercer =
  (def: ShapeDefinition): ImageCoercer =>
  (image: RowImage): Row => {
    const row: Row = {};
    for (const column of def.columns) {
      const value = image[column];
      row[column] =
        column === "id" || column === "room_id"
          ? value == null
            ? (value ?? null)
            : Number(value)
          : (value ?? null);
    }
    return row;
  };

const stamp = { commitLSN: "0/1", systemId: "sys", timelineId: 1 } as const;

describe("predicateNeedsOldImage", () => {
  it("is true when a filter references a non-key column", () => {
    expect(predicateNeedsOldImage(shape())).toBe(true);
  });

  it("is false when every filter is over the key column (a key-only old image suffices)", () => {
    expect(predicateNeedsOldImage(shape([{ column: "id", op: "eq", value: 7 }]))).toBe(false);
  });

  it("is false for a filterless shape", () => {
    expect(predicateNeedsOldImage(shape([]))).toBe(false);
  });
});

describe("assertReplicaIdentity", () => {
  it("refuses a non-key-predicate shape when the table is not REPLICA IDENTITY FULL", () => {
    expect(() => assertReplicaIdentity(shape(), false)).toThrow(LiveServerError);
    try {
      assertReplicaIdentity(shape(), false);
    } catch (error) {
      expect((error as LiveServerError).code).toBe("LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT");
    }
  });

  it("allows a non-key-predicate shape when the table IS REPLICA IDENTITY FULL", () => {
    expect(() => assertReplicaIdentity(shape(), true)).not.toThrow();
  });

  it("allows a key-only-predicate shape regardless of replica identity", () => {
    const keyOnly = shape([{ column: "id", op: "eq", value: 7 }]);
    expect(() => assertReplicaIdentity(keyOnly, false)).not.toThrow();
  });
});

describe("classifyChange — insert", () => {
  const def = shape();
  const coerce = coercer(def);

  it("emits an insert when the new row matches the shape", () => {
    const change: ReplicationChange = {
      op: "insert",
      table: "messages",
      newImage: { id: "5", room_id: "1", body: "hi" },
      ...stamp,
    };
    expect(classifyChange(def, change, coerce)).toEqual({
      op: "insert",
      key: "5",
      row: { id: 5, room_id: 1, body: "hi" },
    });
  });

  it("emits nothing when the new row does not match (never in this client's slice)", () => {
    const change: ReplicationChange = {
      op: "insert",
      table: "messages",
      newImage: { id: "5", room_id: "2", body: "hi" },
      ...stamp,
    };
    expect(classifyChange(def, change, coerce)).toBeUndefined();
  });
});

describe("classifyChange — delete", () => {
  const def = shape();
  const coerce = coercer(def);

  it("emits a delete when the removed row was in the shape", () => {
    const change: ReplicationChange = {
      op: "delete",
      table: "messages",
      oldImage: { id: "5", room_id: "1", body: "hi" },
      ...stamp,
    };
    expect(classifyChange(def, change, coerce)).toEqual({ op: "delete", key: "5" });
  });

  it("emits nothing when the removed row was never in the shape", () => {
    const change: ReplicationChange = {
      op: "delete",
      table: "messages",
      oldImage: { id: "5", room_id: "2", body: "hi" },
      ...stamp,
    };
    expect(classifyChange(def, change, coerce)).toBeUndefined();
  });
});

describe("classifyChange — update (the in/out/stay matrix)", () => {
  const def = shape();
  const coerce = coercer(def);

  const update = (oldImage: RowImage, newImage: RowImage): ReplicationChange => ({
    op: "update",
    table: "messages",
    oldImage,
    newImage,
    ...stamp,
  });

  it("stayed IN → update with the new row", () => {
    const change = update(
      { id: "5", room_id: "1", body: "a" },
      { id: "5", room_id: "1", body: "b" },
    );
    expect(classifyChange(def, change, coerce)).toEqual({
      op: "update",
      key: "5",
      row: { id: 5, room_id: 1, body: "b" },
    });
  });

  it("moved IN (out→in) → insert", () => {
    const change = update(
      { id: "5", room_id: "2", body: "a" },
      { id: "5", room_id: "1", body: "a" },
    );
    expect(classifyChange(def, change, coerce)).toEqual({
      op: "insert",
      key: "5",
      row: { id: 5, room_id: 1, body: "a" },
    });
  });

  it("moved OUT (in→out) → delete-from-shape (the leak-stopping case)", () => {
    const change = update(
      { id: "5", room_id: "1", body: "a" },
      { id: "5", room_id: "2", body: "a" },
    );
    expect(classifyChange(def, change, coerce)).toEqual({ op: "delete", key: "5" });
  });

  it("outside both before and after → nothing", () => {
    const change = update(
      { id: "5", room_id: "2", body: "a" },
      { id: "5", room_id: "3", body: "a" },
    );
    expect(classifyChange(def, change, coerce)).toBeUndefined();
  });

  it("fills an unchanged-TOAST column (undefined in NEW) from the OLD image", () => {
    // body is unchanged-TOAST (undefined) in NEW; the shipped row must carry its old value.
    const change = update(
      { id: "5", room_id: "1", body: "kept" },
      { id: "5", room_id: "1", body: undefined },
    );
    expect(classifyChange(def, change, coerce)).toEqual({
      op: "update",
      key: "5",
      row: { id: 5, room_id: 1, body: "kept" },
    });
  });

  it("classifies membership correctly when the FILTER column is unchanged-TOAST in NEW (uses old value)", () => {
    // room_id (the filter column) not retransmitted → must fall back to old (still 1 = in-shape).
    const change = update(
      { id: "5", room_id: "1", body: "a" },
      { id: "5", room_id: undefined, body: "b" },
    );
    expect(classifyChange(def, change, coerce)).toEqual({
      op: "update",
      key: "5",
      row: { id: 5, room_id: 1, body: "b" },
    });
  });
});
