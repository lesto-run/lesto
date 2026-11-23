import Database from "better-sqlite3";
import { createDb, createTableSql, defineTable, eq, integer, rawChanges, text } from "@lesto/db";
import { describe, expect, it } from "vitest";

import { CloudflareError, d1ToSqlDatabase } from "../src/index";
import type { D1BatchResult, D1Database, D1PreparedStatement } from "../src/index";

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
  batch?: D1BatchResult[];
}

function makeD1(behavior: Behavior = {}): {
  d1: D1Database;
  prepared: string[];
  bound: unknown[][];
  batches: D1PreparedStatement[][];
  statements: D1PreparedStatement[];
} {
  const prepared: string[] = [];
  const bound: unknown[][] = [];
  const batches: D1PreparedStatement[][] = [];
  const statements: D1PreparedStatement[] = [];

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

      statements.push(statement);

      return statement;
    },
    batch: async (batched) => {
      batches.push(batched);

      return behavior.batch ?? [];
    },
  };

  return { d1, prepared, bound, batches, statements };
}

/**
 * A D1 double backed by in-process SQLite: `batch` runs every bound statement
 * inside ONE SQLite transaction and rolls the whole list back on a throw — the
 * atomicity D1 documents. It proves the adapter's mapping (binding, order,
 * result shape) against real SQL; live D1 semantics stay a separate proof.
 */
function sqliteD1(raw: Database.Database): D1Database {
  const execute = new WeakMap<D1PreparedStatement, () => D1BatchResult>();

  return {
    prepare(sql) {
      let bound: unknown[] = [];

      const statement: D1PreparedStatement = {
        bind(...values) {
          bound = values;

          return statement;
        },
        run: async () => ({
          meta: { changes: raw.prepare(sql).run(...(bound as never[])).changes },
        }),
        first: async <T = unknown>() =>
          (raw.prepare(sql).get(...(bound as never[])) ?? null) as T | null,
        all: async <T = unknown>() => ({
          results: raw.prepare(sql).all(...(bound as never[])) as T[],
        }),
      };

      execute.set(statement, () => {
        const prepared = raw.prepare(sql);

        if (prepared.reader) {
          return { results: prepared.all(...(bound as never[])), meta: { changes: 0 } };
        }

        return { results: [], meta: { changes: prepared.run(...(bound as never[])).changes } };
      });

      return statement;
    },
    batch: async (batched) =>
      raw.transaction(() => batched.map((statement) => execute.get(statement)!()))(),
  };
}

const items = defineTable("items", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
  state: text("state").notNull(),
});

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

  it("transaction REFUSES with a coded error — D1 has no interactive transaction — without running the body", async () => {
    const { d1, prepared } = makeD1({ all: [{ id: 9 }] });
    const db = d1ToSqlDatabase(d1);

    let bodyRan = false;
    const body = async (tx: typeof db): Promise<number> => {
      bodyRan = true;
      const rows = await tx.prepare("SELECT 1").all();
      return rows.length;
    };

    // A no-op passthrough would run `body` on the shared handle and RESOLVE — that
    // is the fail-OPEN bug (F3): a read-modify-write there loses updates under
    // concurrent isolates. The adapter must instead REJECT with a coded error so a
    // store that needs cross-statement atomicity fails CLOSED.
    await expect(db.transaction(body)).rejects.toMatchObject({
      code: "CLOUDFLARE_D1_TRANSACTION_UNSUPPORTED",
    });

    // Non-vacuous: `body` was never invoked (no statement prepared through it), so
    // no read-modify-write ever ran non-atomically on the shared handle.
    expect(bodyRan).toBe(false);
    expect(prepared).not.toContain("SELECT 1");
  });

  it("transaction refusal is the coded CloudflareError class (branchable on code, not prose)", async () => {
    const db = d1ToSqlDatabase(makeD1().d1);

    await expect(db.transaction(async () => 1)).rejects.toBeInstanceOf(CloudflareError);
  });

  it("batch calls native d1.batch EXACTLY once, with the bound statements in order", async () => {
    const { d1, bound, batches, statements, prepared } = makeD1({
      batch: [
        { results: [], meta: { changes: 1 } },
        { results: [{ id: 1 }], meta: {} },
      ],
    });

    const results = await d1ToSqlDatabase(d1).batch([
      { sql: "INSERT INTO t VALUES (?)", params: [1], returns: "changes" },
      { sql: "SELECT * FROM t WHERE id = ?", params: [1], returns: "rows" },
    ]);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(statements);
    expect(prepared).toEqual(["INSERT INTO t VALUES (?)", "SELECT * FROM t WHERE id = ?"]);
    expect(bound).toEqual([[1], [1]]);
    expect(results).toEqual([
      { returns: "changes", changes: 1 },
      { returns: "rows", rows: [{ id: 1 }] },
    ]);
  });

  it("batch reads a missing meta.changes as 0", async () => {
    const { d1 } = makeD1({ batch: [{ results: [], meta: {} }] });

    const results = await d1ToSqlDatabase(d1).batch([
      { sql: "UPDATE t SET x = 1", params: [], returns: "changes" },
    ]);

    expect(results).toEqual([{ returns: "changes", changes: 0 }]);
  });

  it("an empty batch resolves [] and never calls d1.batch (D1 refuses an empty list)", async () => {
    const { d1, batches } = makeD1();

    await expect(d1ToSqlDatabase(d1).batch([])).resolves.toEqual([]);
    expect(batches).toEqual([]);
  });

  it("batch refuses, coded, when d1.batch returns fewer results than statements", async () => {
    const { d1 } = makeD1({ batch: [] });

    await expect(
      d1ToSqlDatabase(d1).batch([{ sql: "SELECT 1", params: [], returns: "rows" }]),
    ).rejects.toMatchObject({ code: "CLOUDFLARE_D1_BATCH_RESULT_MISSING" });
  });

  it("stamps the sqlite dialect marker on the handle (D1 speaks SQLite)", () => {
    // The marker lets a consumer (the queue, createDb) infer the engine from the
    // handle itself: D1 is Cloudflare's SQLite, so a queue over D1 must NOT emit
    // `FOR UPDATE SKIP LOCKED`. (No tx-handle assertion here — `transaction()`
    // refuses on D1, so no tx handle ever exists to stamp.)
    expect(d1ToSqlDatabase(makeD1().d1).dialect).toBe("sqlite");
  });
});

describe("d1ToSqlDatabase batch over a SQLite-backed D1 double", () => {
  async function setup(): Promise<{ raw: Database.Database; db: ReturnType<typeof createDb> }> {
    const raw = new Database(":memory:");
    const db = createDb(d1ToSqlDatabase(sqliteD1(raw)));

    await db.exec(createTableSql(items));

    return { raw, db };
  }

  it("all-or-nothing: a constraint violation mid-batch leaves no earlier write", async () => {
    const { raw, db } = await setup();

    await expect(
      db.batch([
        db.insert(items).values({ id: 1, name: "a", state: "new" }),
        db.insert(items).values({ id: 2, name: "a", state: "new" }),
      ]),
    ).rejects.toThrow(/UNIQUE/);

    expect(await db.select().from(items).all()).toEqual([]);

    raw.close();
  });

  it("results match each statement, and a changes()-gated guard sees the earlier write", async () => {
    const { raw, db } = await setup();

    await db.insert(items).values({ id: 1, name: "a", state: "pending" }).run();

    // Fails (NOT NULL) only when the claim before it changed no row — so it must see the claim.
    const guard = rawChanges(
      "INSERT INTO items (id, name, state) SELECT 9, NULL, 'x' WHERE changes() = 0",
    );
    const claim = () => db.update(items).set({ state: "taken" }).where(eq(items.state, "pending"));

    const [claimed, quiet, rows] = await db.batch([claim(), guard, db.select().from(items)]);

    expect(claimed).toEqual({ changes: 1 });
    expect(quiet).toEqual({ changes: 0 });
    expect(rows).toEqual([{ id: 1, name: "a", state: "taken" }]);

    // The same claim again changes nothing, so the guard fires and the earlier
    // insert in the same batch rolls back with it.
    await expect(
      db.batch([db.insert(items).values({ id: 2, name: "b", state: "new" }), claim(), guard]),
    ).rejects.toThrow(/NOT NULL/);

    expect(await db.select().from(items).all()).toEqual([{ id: 1, name: "a", state: "taken" }]);

    raw.close();
  });
});
