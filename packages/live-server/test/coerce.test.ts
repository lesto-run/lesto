import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  boolean,
  createDb,
  createTableSql,
  defineTable,
  integer,
  real,
  text,
  timestamp,
} from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { validateShapeDefinition } from "@lesto/live-protocol";
import type { Row, ShapeDefinition } from "@lesto/live-protocol";

import {
  createImageCoercer,
  normalizeWire,
  projectRow,
  requiredOldImageColumns,
} from "../src/index";
import type { RowImage } from "../src/index";

// A table exercising every column KIND, plus the camelCase(JS key) ↔ snake_case(SQL name) split
// (`roomId`/`room_id`, `createdAt`/`created_at`) the coercer's name-mapping must bridge.
const rows = defineTable("rows", {
  id: integer("id").primaryKey(),
  roomId: integer("room_id").notNull(),
  ratio: real("ratio").notNull(),
  body: text("body").notNull(),
  note: text("note"), // nullable — proves a genuine null round-trips
  flag: boolean("flag").notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/** The room-1 shape: filters the NON-key `roomId`, so it needs the old image (FULL). */
const def: ShapeDefinition = validateShapeDefinition({
  table: "rows",
  key: "id",
  columns: ["id", "roomId", "ratio", "body", "note", "flag", "createdAt"],
  where: [{ column: "roomId", op: "eq", value: 1 }],
  orderBy: undefined,
});

/** Adapt an in-memory SQLite to the async `SqlDatabase` seam (same rig as engine.test.ts). */
function adapt(database: Database.Database): SqlDatabase {
  const adapted: SqlDatabase = {
    exec: async (statement) => {
      database.exec(statement);
    },
    prepare: (statement) => {
      const stmt = database.prepare(statement);

      return {
        run: async (params = []) => stmt.run(...(params as never[])),
        get: async (params = []) => stmt.get(...(params as never[])),
        all: async (params = []) => stmt.all(...(params as never[])),
      };
    },
    transaction: async (fn) => fn(adapted),
  };

  return adapted;
}

let raw: Database.Database;
let db: Db;

beforeEach(async () => {
  raw = new Database(":memory:");
  db = createDb(adapt(raw));
  await db.exec(createTableSql(rows));
});

afterEach(() => raw.close());

describe("createImageCoercer", () => {
  it("projects + coerces a text-encoded pgoutput image to the shape's typed wire row", () => {
    const coerce = createImageCoercer(def, rows);

    // pgoutput text encoding, keyed by SQL column names. boolean + timestamp store as INTEGER, so
    // their pgoutput text is a numeric string ("1", epoch-ms) — no native 't'/'f' or timestamp text.
    const image: RowImage = {
      id: "5",
      room_id: "1",
      ratio: "3.5",
      body: "hi",
      note: null,
      flag: "1",
      created_at: "1000",
    };

    // Keyed by the shape's JS keys; integer/real → number, boolean → bool, timestamp → epoch-ms.
    expect(coerce(image)).toEqual({
      id: 5,
      roomId: 1,
      ratio: 3.5,
      body: "hi",
      note: null,
      flag: true,
      createdAt: 1000,
    });
  });

  it("emits a byte-identical wire row to the v0 db read path (wire parity, ADR 0042 F6)", async () => {
    // The one logical row, written through @lesto/db so storage encoding is real.
    await db
      .insert(rows)
      .values({
        id: 5,
        roomId: 1,
        ratio: 3.5,
        body: "hi",
        note: null,
        flag: true,
        createdAt: new Date(1000),
      })
      .run();

    // v0 path: db.get() hydrates (coerceCell) → project → normalizeWire (Date → epoch-ms).
    const hydrated = (await db.select().from(rows).get()) as unknown as Row;
    const v0Wire = normalizeWire(projectRow(hydrated, def.columns));

    // v1 path: the same logical row as a text-encoded pgoutput image → the db-backed coercer.
    const image: RowImage = {
      id: "5",
      room_id: "1",
      ratio: "3.5",
      body: "hi",
      note: null,
      flag: "1",
      created_at: "1000",
    };
    const v1Wire = createImageCoercer(def, rows)(image);

    // The whole point: both change sources produce the SAME scalars for the SAME row.
    expect(v1Wire).toEqual(v0Wire);
  });
});

describe("requiredOldImageColumns", () => {
  it("returns the SQL names of the key + filter columns when the predicate needs the old image", () => {
    // roomId is a non-key filter → the old image must carry both id (key) and room_id (filter).
    expect(requiredOldImageColumns(def, rows)).toEqual(["id", "room_id"]);
  });

  it("dedups the key when a filter is also on the key column", () => {
    const keyAndNonKey = validateShapeDefinition({
      ...def,
      where: [
        { column: "id", op: "gt", value: 0 },
        { column: "roomId", op: "eq", value: 1 },
      ],
    });

    expect(requiredOldImageColumns(keyAndNonKey, rows)).toEqual(["id", "room_id"]);
  });

  it("requires nothing of the old image for a key-only predicate (decidable from the new image)", () => {
    const keyOnly = validateShapeDefinition({
      ...def,
      where: [{ column: "id", op: "eq", value: 5 }],
    });

    expect(requiredOldImageColumns(keyOnly, rows)).toEqual([]);
  });

  it("requires nothing of the old image for a filterless shape (always in the shape)", () => {
    const filterless = validateShapeDefinition({ ...def, where: [] });

    expect(requiredOldImageColumns(filterless, rows)).toEqual([]);
  });
});
