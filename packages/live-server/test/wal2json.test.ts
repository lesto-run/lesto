import { describe, expect, it } from "vitest";

import { decodeWal2JsonChange, zipImage, type Wal2JsonChange } from "../src/wal2json";

describe("zipImage", () => {
  it("zips parallel name/value arrays into a row image", () => {
    expect(zipImage(["id", "room_id", "body"], [1, 42, "hi"])).toEqual({
      id: 1,
      room_id: 42,
      body: "hi",
    });
  });

  it("is an empty object when there are no columns", () => {
    expect(zipImage([], [])).toEqual({});
  });

  it("carries a null/undefined value through rather than dropping the column", () => {
    expect(zipImage(["a", "b"], [null, undefined])).toEqual({ a: null, b: undefined });
  });
});

describe("decodeWal2JsonChange", () => {
  const commitLSN = "0/16B3748";

  it("decodes an insert to newImage only", () => {
    const change: Wal2JsonChange = {
      kind: "insert",
      table: "messages",
      columnnames: ["id", "room_id"],
      columnvalues: [1, 42],
    };

    expect(decodeWal2JsonChange(change, commitLSN)).toEqual({
      op: "insert",
      table: "messages",
      commitLSN,
      newImage: { id: 1, room_id: 42 },
    });
  });

  it("decodes an update to both new and old images", () => {
    const change: Wal2JsonChange = {
      kind: "update",
      table: "messages",
      columnnames: ["id", "room_id"],
      columnvalues: [1, 99],
      oldkeys: { keynames: ["id", "room_id"], keyvalues: [1, 42] },
    };

    expect(decodeWal2JsonChange(change, commitLSN)).toEqual({
      op: "update",
      table: "messages",
      commitLSN,
      newImage: { id: 1, room_id: 99 },
      oldImage: { id: 1, room_id: 42 },
    });
  });

  it("decodes a delete to oldImage only", () => {
    const change: Wal2JsonChange = {
      kind: "delete",
      table: "messages",
      oldkeys: { keynames: ["id"], keyvalues: [7] },
    };

    expect(decodeWal2JsonChange(change, commitLSN)).toEqual({
      op: "delete",
      table: "messages",
      commitLSN,
      oldImage: { id: 7 },
    });
  });

  it("defaults absent column/oldkey arrays to empty images (a degraded old image is indistinguishable — the shape engine guards it)", () => {
    const insert = decodeWal2JsonChange({ kind: "insert", table: "t" }, commitLSN);
    const del = decodeWal2JsonChange({ kind: "delete", table: "t" }, commitLSN);

    expect(insert).toEqual({ op: "insert", table: "t", commitLSN, newImage: {} });
    expect(del).toEqual({ op: "delete", table: "t", commitLSN, oldImage: {} });
  });
});
