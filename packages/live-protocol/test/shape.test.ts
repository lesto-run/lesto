import { describe, expect, it } from "vitest";

import {
  compareRows,
  LiveProtocolError,
  matchesShape,
  parseShapeDefinition,
  rowKey,
  serializeShapeDefinition,
  shapeId,
  validateShapeDefinition,
} from "../src/index";
import type { ShapeDefinition } from "../src/index";

/** A canonical, valid shape: `messages WHERE room_id = 1`, newest first, keyed by id. */
function messagesShape(overrides: Partial<ShapeDefinition> = {}): ShapeDefinition {
  return {
    table: "messages",
    key: "id",
    columns: ["id", "roomId", "body", "createdAt"],
    where: [{ column: "roomId", op: "eq", value: 1 }],
    orderBy: { column: "createdAt", direction: "desc" },
    ...overrides,
  };
}

describe("validateShapeDefinition — the trust boundary", () => {
  it("accepts and freezes a well-formed shape", () => {
    const def = validateShapeDefinition(messagesShape());

    expect(def.table).toBe("messages");
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.columns)).toBe(true);
    expect(Object.isFrozen(def.where)).toBe(true);
  });

  it("accepts an empty `where` (the whole table) and an absent `orderBy`", () => {
    const def = validateShapeDefinition({
      table: "t",
      key: "id",
      columns: ["id"],
      where: [],
      orderBy: undefined,
    });

    expect(def.where).toEqual([]);
    expect(def.orderBy).toBeUndefined();
  });

  it("treats a null `orderBy` as key-order only", () => {
    const def = validateShapeDefinition({
      table: "t",
      key: "id",
      columns: ["id"],
      where: [],
      orderBy: null,
    });

    expect(def.orderBy).toBeUndefined();
  });

  const rejects: Array<[string, unknown]> = [
    ["a non-object", 42],
    ["null", null],
    ["a blank table", messagesShape({ table: "" })],
    ["a blank key", messagesShape({ key: "" })],
    ["a key not among columns", messagesShape({ key: "missing" })],
    ["empty columns", messagesShape({ columns: [] })],
    ["a non-array columns", { ...messagesShape(), columns: "id" }],
    ["a non-string column", { ...messagesShape(), columns: ["id", 7] }],
    ["a non-array where", { ...messagesShape(), where: {} }],
    ["a non-object filter", { ...messagesShape(), where: [1] }],
    [
      "a filter with a blank column",
      messagesShape({ where: [{ column: "", op: "eq", value: 1 }] }),
    ],
    [
      "a filter column not among columns",
      messagesShape({ where: [{ column: "nope", op: "eq", value: 1 }] }),
    ],
    [
      "a filter with an unknown op",
      { ...messagesShape(), where: [{ column: "roomId", op: "between", value: 1 }] },
    ],
    [
      "a filter with a non-scalar value",
      { ...messagesShape(), where: [{ column: "roomId", op: "eq", value: { a: 1 } }] },
    ],
    [
      "a filter with a non-finite number",
      messagesShape({ where: [{ column: "roomId", op: "gt", value: Number.POSITIVE_INFINITY }] }),
    ],
    ["a non-object orderBy", { ...messagesShape(), orderBy: 5 }],
    [
      "an orderBy with a blank column",
      messagesShape({ orderBy: { column: "", direction: "asc" } }),
    ],
    [
      "an orderBy column not among columns",
      messagesShape({ orderBy: { column: "nope", direction: "asc" } }),
    ],
    [
      "an orderBy with a bad direction",
      { ...messagesShape(), orderBy: { column: "createdAt", direction: "sideways" } },
    ],
  ];

  it.each(rejects)("rejects %s", (_label, value) => {
    expect(() => validateShapeDefinition(value)).toThrow(LiveProtocolError);
    try {
      validateShapeDefinition(value);
    } catch (error) {
      expect((error as LiveProtocolError).code).toBe("LIVE_PROTOCOL_INVALID_SHAPE");
    }
  });
});

describe("shapeId — a stable, deterministic subscribe/cache key", () => {
  it("is prefixed by the table and stable across calls", () => {
    const id = shapeId(messagesShape());

    expect(id).toMatch(/^messages:[0-9a-f]{8}$/);
    expect(shapeId(messagesShape())).toBe(id);
  });

  it("differs when a bound parameter differs (the capability is part of the id)", () => {
    expect(shapeId(messagesShape({ where: [{ column: "roomId", op: "eq", value: 1 }] }))).not.toBe(
      shapeId(messagesShape({ where: [{ column: "roomId", op: "eq", value: 2 }] })),
    );
  });

  it("differs when the order changes", () => {
    expect(shapeId(messagesShape({ orderBy: { column: "createdAt", direction: "asc" } }))).not.toBe(
      shapeId(messagesShape({ orderBy: { column: "createdAt", direction: "desc" } })),
    );
    expect(shapeId(messagesShape({ orderBy: undefined }))).not.toBe(shapeId(messagesShape()));
  });
});

describe("rowKey — row identity within a shape", () => {
  it("stringifies the key column's value", () => {
    expect(rowKey({ id: 7, body: "hi" }, "id")).toBe("7");
    expect(rowKey({ id: "abc" }, "id")).toBe("abc");
  });

  it("throws LIVE_PROTOCOL_MISSING_KEY when the key value is null or absent", () => {
    expect(() => rowKey({ id: null }, "id")).toThrow(LiveProtocolError);
    try {
      rowKey({}, "id");
    } catch (error) {
      expect((error as LiveProtocolError).code).toBe("LIVE_PROTOCOL_MISSING_KEY");
    }
  });
});

describe("matchesShape — the per-row predicate (AND of conjuncts)", () => {
  it("an empty filter matches every row", () => {
    expect(matchesShape(messagesShape({ where: [] }), { id: 1 })).toBe(true);
  });

  it("eq / ne compare exactly", () => {
    const def = messagesShape({ where: [{ column: "roomId", op: "eq", value: 1 }] });

    expect(matchesShape(def, { id: 1, roomId: 1 })).toBe(true);
    expect(matchesShape(def, { id: 2, roomId: 2 })).toBe(false);

    const ne = messagesShape({ where: [{ column: "roomId", op: "ne", value: 1 }] });

    expect(matchesShape(ne, { id: 2, roomId: 2 })).toBe(true);
    expect(matchesShape(ne, { id: 1, roomId: 1 })).toBe(false);
  });

  it("eq / ne follow SQL 3-valued logic: a NULL on either side is never a match", () => {
    // SQL `col = v` / `col <> v` are both NULL (never TRUE) when either operand is NULL, so both
    // EXCLUDE — matching a SQL-rendered snapshot's WHERE, which the CDN-snapshot path re-renders. A
    // first-class-NULL `Object.is` would instead INCLUDE a null cell under `ne` and match null cells
    // under `eq null`, leaking a row present incrementally but absent from the authoritative snapshot.
    const eq = messagesShape({ where: [{ column: "roomId", op: "eq", value: 1 }] });
    const ne = messagesShape({ where: [{ column: "roomId", op: "ne", value: 1 }] });

    // A NULL cell: `= 1` excludes, and `<> 1` ALSO excludes (not includes).
    expect(matchesShape(eq, { id: 1, roomId: null })).toBe(false);
    expect(matchesShape(ne, { id: 1, roomId: null })).toBe(false);

    // A missing column (an undefined cell) is likewise never a match under eq/ne.
    expect(matchesShape(eq, { id: 1 })).toBe(false);
    expect(matchesShape(ne, { id: 1 })).toBe(false);

    // A NULL bound value matches nothing — `col = NULL` / `col <> NULL` are never TRUE in SQL (a
    // future `IS NULL` op, not `eq null`, would express null membership). Present and null cells alike.
    const eqNull = messagesShape({ where: [{ column: "roomId", op: "eq", value: null }] });
    const neNull = messagesShape({ where: [{ column: "roomId", op: "ne", value: null }] });

    expect(matchesShape(eqNull, { id: 1, roomId: 1 })).toBe(false);
    expect(matchesShape(eqNull, { id: 1, roomId: null })).toBe(false);
    expect(matchesShape(neNull, { id: 1, roomId: 1 })).toBe(false);
  });

  it("gt / gte / lt / lte compare in order", () => {
    const gt = messagesShape({ where: [{ column: "createdAt", op: "gt", value: 10 }] });
    const gte = messagesShape({ where: [{ column: "createdAt", op: "gte", value: 10 }] });
    const lt = messagesShape({ where: [{ column: "createdAt", op: "lt", value: 10 }] });
    const lte = messagesShape({ where: [{ column: "createdAt", op: "lte", value: 10 }] });

    expect(matchesShape(gt, { id: 1, createdAt: 11 })).toBe(true);
    expect(matchesShape(gt, { id: 1, createdAt: 10 })).toBe(false);
    expect(matchesShape(gte, { id: 1, createdAt: 10 })).toBe(true);
    expect(matchesShape(gte, { id: 1, createdAt: 9 })).toBe(false);
    expect(matchesShape(lt, { id: 1, createdAt: 9 })).toBe(true);
    expect(matchesShape(lt, { id: 1, createdAt: 10 })).toBe(false);
    expect(matchesShape(lte, { id: 1, createdAt: 10 })).toBe(true);
    expect(matchesShape(lte, { id: 1, createdAt: 11 })).toBe(false);
  });

  it("an ordered comparison against null (either side) is never true", () => {
    const gt = messagesShape({ where: [{ column: "createdAt", op: "gt", value: 10 }] });

    expect(matchesShape(gt, { id: 1, createdAt: null })).toBe(false);

    const gtNull = messagesShape({ where: [{ column: "createdAt", op: "gt", value: null }] });

    expect(matchesShape(gtNull, { id: 1, createdAt: 10 })).toBe(false);
  });

  it("ANDs multiple conjuncts", () => {
    const def = messagesShape({
      where: [
        { column: "roomId", op: "eq", value: 1 },
        { column: "createdAt", op: "gte", value: 100 },
      ],
    });

    expect(matchesShape(def, { id: 1, roomId: 1, createdAt: 150 })).toBe(true);
    expect(matchesShape(def, { id: 1, roomId: 1, createdAt: 50 })).toBe(false);
    expect(matchesShape(def, { id: 1, roomId: 2, createdAt: 150 })).toBe(false);
  });
});

describe("compareRows — the total order", () => {
  it("orders by the sort column, respecting direction", () => {
    const desc = messagesShape();

    expect(compareRows(desc, { id: 1, createdAt: 200 }, { id: 2, createdAt: 100 })).toBeLessThan(0);
    expect(compareRows(desc, { id: 1, createdAt: 100 }, { id: 2, createdAt: 200 })).toBeGreaterThan(
      0,
    );

    const asc = messagesShape({ orderBy: { column: "createdAt", direction: "asc" } });

    expect(compareRows(asc, { id: 1, createdAt: 100 }, { id: 2, createdAt: 200 })).toBeLessThan(0);
  });

  it("breaks a sort-column tie by the unique key (a total order)", () => {
    const def = messagesShape();

    expect(compareRows(def, { id: 5, createdAt: 100 }, { id: 9, createdAt: 100 })).toBeLessThan(0);
    expect(compareRows(def, { id: 9, createdAt: 100 }, { id: 5, createdAt: 100 })).toBeGreaterThan(
      0,
    );
    expect(compareRows(def, { id: 5, createdAt: 100 }, { id: 5, createdAt: 100 })).toBe(0);
  });

  it("orders by the key alone when there is no orderBy", () => {
    const def = messagesShape({ orderBy: undefined });

    expect(compareRows(def, { id: 1 }, { id: 2 })).toBeLessThan(0);
  });

  it("treats incomparable cells (NaN) as equal — the deterministic defensive fallthrough", () => {
    // NaN is `!==` itself yet neither `<` nor `>` any value: the compareCells branch
    // that must still return a stable 0 rather than fall off the end.
    const def = messagesShape({ orderBy: undefined });

    expect(compareRows(def, { id: Number.NaN }, { id: Number.NaN })).toBe(0);
  });

  it("sorts null cells first", () => {
    const def = messagesShape({ orderBy: { column: "createdAt", direction: "asc" } });

    expect(compareRows(def, { id: 1, createdAt: null }, { id: 2, createdAt: 5 })).toBeLessThan(0);
    expect(compareRows(def, { id: 1, createdAt: 5 }, { id: 2, createdAt: null })).toBeGreaterThan(
      0,
    );
  });

  it("is a stable strict order over a real sort", () => {
    const def = messagesShape();
    const rows = [
      { id: 3, createdAt: 100 },
      { id: 1, createdAt: 200 },
      { id: 2, createdAt: 100 },
    ];

    const sorted = rows.toSorted((a, b) => compareRows(def, a, b));

    expect(sorted.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});

describe("serialize / parse — the subscribe-request round-trip", () => {
  it("round-trips a valid shape", () => {
    const def = messagesShape();
    const parsed = parseShapeDefinition(serializeShapeDefinition(def));

    expect(shapeId(parsed)).toBe(shapeId(def));
    expect(parsed).toEqual(validateShapeDefinition(def));
  });

  it("serialize rejects an invalid shape", () => {
    expect(() => serializeShapeDefinition(messagesShape({ key: "missing" }))).toThrow(
      LiveProtocolError,
    );
  });

  it("parse rejects non-JSON", () => {
    try {
      parseShapeDefinition("{not json");
    } catch (error) {
      expect((error as LiveProtocolError).code).toBe("LIVE_PROTOCOL_INVALID_SHAPE");
    }

    expect(() => parseShapeDefinition("{not json")).toThrow(LiveProtocolError);
  });

  it("parse rejects valid JSON that is not a valid shape", () => {
    expect(() => parseShapeDefinition(JSON.stringify({ table: "t" }))).toThrow(LiveProtocolError);
  });
});
