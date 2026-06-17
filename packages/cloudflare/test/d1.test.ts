import { describe, expect, it } from "vitest";

import { d1ToSqlDatabase } from "../src/index";
import type { D1Database, D1PreparedStatement } from "../src/index";

/**
 * A configurable fake D1 binding: every prepared statement resolves to the
 * supplied `meta` / `first` / `all` behavior, and the fake records the SQL it
 * prepared and the values it was bound with — enough to drive every branch of the
 * adapter without a real D1.
 */
interface Behavior {
  meta?: { changes?: number; last_row_id?: number };
  first?: unknown;
  all?: unknown[];
}

function makeD1(behavior: Behavior = {}): {
  d1: D1Database;
  prepared: string[];
  bound: unknown[][];
} {
  const prepared: string[] = [];
  const bound: unknown[][] = [];

  const d1: D1Database = {
    prepare(sql) {
      prepared.push(sql);

      const statement: D1PreparedStatement = {
        bind(...values) {
          bound.push(values);
          return statement;
        },
        run: async () => ({ meta: behavior.meta ?? {} }),
        first: async <T = unknown>() => (behavior.first ?? null) as T | null,
        all: async <T = unknown>() => ({ results: (behavior.all ?? []) as T[] }),
      };

      return statement;
    },
  };

  return { d1, prepared, bound };
}

describe("d1ToSqlDatabase", () => {
  it("exec prepares + runs the SQL as a single statement (no newline splitting)", async () => {
    const { d1, prepared } = makeD1();

    await d1ToSqlDatabase(d1).exec("CREATE TABLE t (\n  id INTEGER\n)");

    // One prepared statement carrying the whole multi-line DDL — not `d1.exec`.
    expect(prepared).toEqual(["CREATE TABLE t (\n  id INTEGER\n)"]);
  });

  it("run returns changes + lastInsertRowid and binds the params", async () => {
    const { d1, bound } = makeD1({ meta: { changes: 3, last_row_id: 7 } });

    const result = await d1ToSqlDatabase(d1).prepare("INSERT INTO t VALUES (?, ?)").run([1, "a"]);

    expect(result).toEqual({ changes: 3, lastInsertRowid: 7 });
    expect(bound).toEqual([[1, "a"]]);
  });

  it("run defaults changes to 0 and omits lastInsertRowid when D1 reports neither", async () => {
    const { d1 } = makeD1({ meta: {} });

    // No params arg -> the `params = []` default; empty meta -> `changes ?? 0`.
    const result = await d1ToSqlDatabase(d1).prepare("UPDATE t SET x = 1").run();

    expect(result).toEqual({ changes: 0 });
    expect("lastInsertRowid" in result).toBe(false);
  });

  it("run keeps a zero lastInsertRowid (defined, not dropped as falsy)", async () => {
    const { d1 } = makeD1({ meta: { changes: 1, last_row_id: 0 } });

    const result = await d1ToSqlDatabase(d1).prepare("INSERT INTO t DEFAULT VALUES").run([]);

    expect(result).toEqual({ changes: 1, lastInsertRowid: 0 });
  });

  it("get returns the row and binds the params", async () => {
    const { d1, bound } = makeD1({ first: { id: 1, title: "x" } });

    const row = await d1ToSqlDatabase(d1).prepare("SELECT * FROM t WHERE id = ?").get([1]);

    expect(row).toEqual({ id: 1, title: "x" });
    expect(bound).toEqual([[1]]);
  });

  it("get maps D1's null miss to undefined (with default params)", async () => {
    const { d1 } = makeD1({ first: null });

    const row = await d1ToSqlDatabase(d1).prepare("SELECT * FROM t").get();

    expect(row).toBeUndefined();
  });

  it("all returns the results array and binds the params", async () => {
    const { d1, bound } = makeD1({ all: [{ id: 1 }, { id: 2 }] });

    const rows = await d1ToSqlDatabase(d1).prepare("SELECT * FROM t WHERE x = ?").all(["a"]);

    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(bound).toEqual([["a"]]);
  });

  it("all defaults to no params and an empty result set", async () => {
    const { d1 } = makeD1();

    const rows = await d1ToSqlDatabase(d1).prepare("SELECT * FROM t").all();

    expect(rows).toEqual([]);
  });

  it("transaction runs the body on the same handle and returns its value", async () => {
    const { d1, prepared } = makeD1({ all: [{ id: 9 }] });
    const db = d1ToSqlDatabase(d1);

    const count = await db.transaction(async (tx) => {
      const rows = await tx.prepare("SELECT 1").all();
      return rows.length;
    });

    expect(count).toBe(1);
    expect(prepared).toContain("SELECT 1");
  });
});
