import { describe, expect, it } from "vitest";

import type { Row, RowKey, ShapeDefinition } from "@lesto/live-protocol";

import { diffRows, normalizeWire, projectRow } from "../src/index";

const def: ShapeDefinition = {
  table: "messages",
  key: "id",
  columns: ["id", "body"],
  where: [],
  orderBy: undefined,
};

/** Build a keyed prev-map the way the engine does. */
function keyed(rows: readonly Row[]): Map<RowKey, Row> {
  return new Map(rows.map((row) => [String(row.id), row]));
}

describe("projectRow", () => {
  it("keeps exactly the projected columns, dropping the rest", () => {
    expect(projectRow({ id: 1, body: "hi", secret: "x" }, ["id", "body"])).toEqual({
      id: 1,
      body: "hi",
    });
  });

  it("carries a projected column absent from the row as undefined", () => {
    expect(projectRow({ id: 1 }, ["id", "body"])).toEqual({ id: 1, body: undefined });
  });
});

describe("normalizeWire", () => {
  it("folds a Date to epoch-ms and passes scalars through", () => {
    const when = new Date(1_700_000_000_000);

    expect(normalizeWire({ id: 1, createdAt: when, body: "hi", ok: true, n: null })).toEqual({
      id: 1,
      createdAt: 1_700_000_000_000,
      body: "hi",
      ok: true,
      n: null,
    });
  });

  it("makes two equal timestamps compare equal (no spurious update)", () => {
    const a = normalizeWire({ id: 1, at: new Date(5) });
    const b = normalizeWire({ id: 1, at: new Date(5) });

    expect(a).toEqual(b);
  });
});

describe("diffRows", () => {
  it("emits an insert for a new key", () => {
    const { changes, next } = diffRows(def, keyed([]), [{ id: 1, body: "hi" }]);

    expect(changes).toEqual([{ op: "insert", key: "1", row: { id: 1, body: "hi" } }]);
    expect(next.get("1")).toEqual({ id: 1, body: "hi" });
  });

  it("emits an update only when the row changed", () => {
    const prev = keyed([{ id: 1, body: "hi" }]);

    expect(diffRows(def, prev, [{ id: 1, body: "hi" }]).changes).toEqual([]);
    expect(diffRows(def, prev, [{ id: 1, body: "yo" }]).changes).toEqual([
      { op: "update", key: "1", row: { id: 1, body: "yo" } },
    ]);
  });

  it("emits a delete-from-shape for a key that left", () => {
    const prev = keyed([
      { id: 1, body: "a" },
      { id: 2, body: "b" },
    ]);

    const { changes } = diffRows(def, prev, [{ id: 1, body: "a" }]);

    expect(changes).toEqual([{ op: "delete", key: "2" }]);
  });

  it("orders inserts/updates first (in next order), deletes last (in prev order)", () => {
    const prev = keyed([
      { id: 1, body: "a" },
      { id: 2, body: "b" },
    ]);

    const { changes } = diffRows(def, prev, [
      { id: 2, body: "B" }, // update
      { id: 3, body: "c" }, // insert
    ]);

    expect(changes).toEqual([
      { op: "update", key: "2", row: { id: 2, body: "B" } },
      { op: "insert", key: "3", row: { id: 3, body: "c" } },
      { op: "delete", key: "1" },
    ]);
  });

  it("treats a differing column count as a change", () => {
    const prev = keyed([{ id: 1, body: "hi" }]);

    // A next row with an extra key differs by length → update.
    const { changes } = diffRows(def, prev, [{ id: 1, body: "hi", extra: 1 }]);

    expect(changes).toEqual([{ op: "update", key: "1", row: { id: 1, body: "hi", extra: 1 } }]);
  });
});
