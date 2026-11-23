import { describe, expect, it } from "vitest";

import { hyperdriveToSqlDatabase } from "../src/index";
import type { HyperdriveConnection, HyperdriveQueryResult } from "../src/index";

/**
 * A configurable fake Hyperdrive connection: every `query` runs through the
 * supplied handler and is recorded (text + values), so we can assert the
 * `?`→`$n` translation, the statement mapping, and the BEGIN/COMMIT/ROLLBACK
 * bracketing without a real Hyperdrive or Postgres — mirroring the D1 fake.
 */
interface QueryCall {
  text: string;
  values: unknown[];
}

type Handler = (text: string, values: unknown[]) => HyperdriveQueryResult;

function makeHyperdrive(handler: Handler = () => ({ rows: [], rowCount: 0 })): {
  connection: HyperdriveConnection;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];

  const connection: HyperdriveConnection = {
    query: async (text, values = []) => {
      calls.push({ text, values });

      return handler(text, values);
    },
  };

  return { connection, calls };
}

describe("hyperdriveToSqlDatabase — statements", () => {
  it("exec runs the SQL verbatim on the connection (no translation, no params)", async () => {
    const { connection, calls } = makeHyperdrive();

    await hyperdriveToSqlDatabase(connection).exec("CREATE TABLE t (\n  id INTEGER\n)");

    expect(calls).toEqual([{ text: "CREATE TABLE t (\n  id INTEGER\n)", values: [] }]);
  });

  it("prepare translates `?` to `$n` once; run reports changes and binds the params", async () => {
    const { connection, calls } = makeHyperdrive(() => ({ rows: [], rowCount: 3 }));

    const result = await hyperdriveToSqlDatabase(connection)
      .prepare("UPDATE t SET a = ? WHERE b = ?")
      .run([1, 2]);

    expect(result).toEqual({ changes: 3 });
    expect(calls[0]?.text).toBe("UPDATE t SET a = $1 WHERE b = $2");
    expect(calls[0]?.values).toEqual([1, 2]);
  });

  it("run returns only { changes } — lastInsertRowid is never inferred (pg omits it)", async () => {
    // Even when a RETURNING row comes back, run() does NOT leak an id; a caller
    // that wants the id reads it via RETURNING id + .get().
    const { connection } = makeHyperdrive(() => ({ rows: [{ id: 42 }], rowCount: 1 }));

    const result = await hyperdriveToSqlDatabase(connection)
      .prepare("INSERT INTO t (a) VALUES (?) RETURNING id")
      .run(["x"]);

    expect(result).toEqual({ changes: 1 });
    expect("lastInsertRowid" in result).toBe(false);
  });

  it("run treats a null rowCount as 0 changes (with default params)", async () => {
    const { connection, calls } = makeHyperdrive(() => ({ rows: [], rowCount: null }));

    // No params arg -> the `params = []` default.
    const result = await hyperdriveToSqlDatabase(connection).prepare("UPDATE t SET a = 1").run();

    expect(result).toEqual({ changes: 0 });
    expect(calls[0]?.values).toEqual([]);
  });

  it("get returns the first row and binds the params", async () => {
    const { connection, calls } = makeHyperdrive(() => ({
      rows: [{ id: 1, title: "x" }],
      rowCount: 1,
    }));

    const row = await hyperdriveToSqlDatabase(connection)
      .prepare("SELECT * FROM t WHERE id = ?")
      .get([1]);

    expect(row).toEqual({ id: 1, title: "x" });
    expect(calls[0]?.values).toEqual([1]);
  });

  it("get returns undefined when there are no rows (with default params)", async () => {
    const { connection, calls } = makeHyperdrive(() => ({ rows: [], rowCount: 0 }));

    const row = await hyperdriveToSqlDatabase(connection).prepare("SELECT * FROM t").get();

    expect(row).toBeUndefined();
    expect(calls[0]?.values).toEqual([]);
  });

  it("all returns every row and binds the params", async () => {
    const { connection, calls } = makeHyperdrive(() => ({
      rows: [{ id: 1 }, { id: 2 }],
      rowCount: 2,
    }));

    const rows = await hyperdriveToSqlDatabase(connection)
      .prepare("SELECT * FROM t WHERE x = ?")
      .all(["a"]);

    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls[0]?.values).toEqual(["a"]);
  });

  it("all defaults to no params and an empty result set", async () => {
    const { connection, calls } = makeHyperdrive();

    const rows = await hyperdriveToSqlDatabase(connection).prepare("SELECT * FROM t").all();

    expect(rows).toEqual([]);
    expect(calls[0]?.values).toEqual([]);
  });
});

describe("hyperdriveToSqlDatabase — transaction", () => {
  it("brackets BEGIN/COMMIT around the body and returns its value", async () => {
    const { connection, calls } = makeHyperdrive(() => ({ rows: [], rowCount: 1 }));
    const db = hyperdriveToSqlDatabase(connection);

    const out = await db.transaction(async (tx) => {
      await tx.exec("INSERT INTO t (a) VALUES (1)");

      return "done";
    });

    expect(out).toBe("done");
    expect(calls.map((c) => c.text)).toEqual(["BEGIN", "INSERT INTO t (a) VALUES (1)", "COMMIT"]);
  });

  it("rolls back and re-raises the original error when the body throws", async () => {
    const { connection, calls } = makeHyperdrive(() => ({ rows: [], rowCount: 0 }));
    const db = hyperdriveToSqlDatabase(connection);

    const boom = new Error("boom");

    await expect(
      db.transaction(async (tx) => {
        await tx.exec("INSERT INTO t (a) VALUES (1)");

        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(calls.map((c) => c.text)).toEqual(["BEGIN", "INSERT INTO t (a) VALUES (1)", "ROLLBACK"]);
  });

  it("a failing ROLLBACK does not mask the original error", async () => {
    // The body throws, then ROLLBACK itself throws — the ORIGINAL error must win.
    const { connection } = makeHyperdrive((text) => {
      if (text === "ROLLBACK") throw new Error("rollback failed");

      return { rows: [], rowCount: 0 };
    });
    const db = hyperdriveToSqlDatabase(connection);

    const boom = new Error("original");

    await expect(
      db.transaction(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("a nested transaction runs flat on the same connection (no second BEGIN)", async () => {
    const { connection, calls } = makeHyperdrive(() => ({ rows: [], rowCount: 1 }));
    const db = hyperdriveToSqlDatabase(connection);

    const out = await db.transaction(async (tx) =>
      tx.transaction(async (inner) => {
        await inner.exec("UPDATE t SET a = 1");

        return "nested";
      }),
    );

    expect(out).toBe("nested");
    // One BEGIN/COMMIT around the whole span; the inner transaction added no
    // second BEGIN.
    expect(calls.filter((c) => c.text === "BEGIN")).toHaveLength(1);
    expect(calls.filter((c) => c.text === "COMMIT")).toHaveLength(1);
    expect(calls.map((c) => c.text)).toEqual(["BEGIN", "UPDATE t SET a = 1", "COMMIT"]);
  });

  it("stamps the postgres dialect marker on the handle AND on the tx handle", async () => {
    const { connection } = makeHyperdrive();
    const db = hyperdriveToSqlDatabase(connection);

    // Hyperdrive fronts a real Postgres, so the marker lets a consumer (the
    // queue, createDb) infer `"postgres"` from the handle itself — and the tx
    // handle is a SqlDatabase too, so it must carry the same stamp.
    expect(db.dialect).toBe("postgres");

    await db.transaction(async (tx) => {
      expect(tx.dialect).toBe("postgres");
    });
  });
});

describe("hyperdriveToSqlDatabase — batch", () => {
  it("runs the statements in order inside ONE BEGIN/COMMIT, with per-statement results", async () => {
    const { connection, calls } = makeHyperdrive((text) =>
      text.startsWith("SELECT") ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 2 },
    );

    const results = await hyperdriveToSqlDatabase(connection).batch([
      { sql: "UPDATE t SET a = ? WHERE b = ?", params: [1, 2], returns: "changes" },
      { sql: "SELECT * FROM t WHERE a = ?", params: [1], returns: "rows" },
    ]);

    expect(results).toEqual([
      { returns: "changes", changes: 2 },
      { returns: "rows", rows: [{ id: 1 }] },
    ]);
    expect(calls).toEqual([
      { text: "BEGIN", values: [] },
      { text: "UPDATE t SET a = $1 WHERE b = $2", values: [1, 2] },
      { text: "SELECT * FROM t WHERE a = $1", values: [1] },
      { text: "COMMIT", values: [] },
    ]);
  });

  it("all-or-nothing: a failing statement rolls back the span and stops the batch", async () => {
    const violation = new Error("duplicate key value violates unique constraint");
    const { connection, calls } = makeHyperdrive((text) => {
      if (text.startsWith("INSERT INTO t (b)")) throw violation;

      return { rows: [], rowCount: 1 };
    });

    await expect(
      hyperdriveToSqlDatabase(connection).batch([
        { sql: "INSERT INTO t (a) VALUES (?)", params: [1], returns: "changes" },
        { sql: "INSERT INTO t (b) VALUES (?)", params: [2], returns: "changes" },
        { sql: "INSERT INTO t (c) VALUES (?)", params: [3], returns: "changes" },
      ]),
    ).rejects.toBe(violation);

    expect(calls.map((c) => c.text)).toEqual([
      "BEGIN",
      "INSERT INTO t (a) VALUES ($1)",
      "INSERT INTO t (b) VALUES ($1)",
      "ROLLBACK",
    ]);
  });

  it("an empty batch resolves [] and never opens a transaction", async () => {
    const { connection, calls } = makeHyperdrive();

    await expect(hyperdriveToSqlDatabase(connection).batch([])).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a batch on the tx handle runs in a SAVEPOINT; a caught failure rolls back only the batch", async () => {
    const violation = new Error("duplicate key value violates unique constraint");
    const { connection, calls } = makeHyperdrive((text) => {
      if (text.startsWith("INSERT INTO t (b)")) throw violation;

      return { rows: [], rowCount: 1 };
    });

    await hyperdriveToSqlDatabase(connection).transaction(async (tx) => {
      await tx.batch([{ sql: "UPDATE t SET a = 1", params: [], returns: "changes" }]);

      await expect(
        tx.batch([
          { sql: "INSERT INTO t (a) VALUES (?)", params: [1], returns: "changes" },
          { sql: "INSERT INTO t (b) VALUES (?)", params: [1], returns: "changes" },
        ]),
      ).rejects.toBe(violation);
    });

    expect(calls.map((c) => c.text.replace(/lesto_batch_\d+/, "lesto_batch_N"))).toEqual([
      "BEGIN",
      "SAVEPOINT lesto_batch_N",
      "UPDATE t SET a = 1",
      "RELEASE SAVEPOINT lesto_batch_N",
      "SAVEPOINT lesto_batch_N",
      "INSERT INTO t (a) VALUES ($1)",
      "INSERT INTO t (b) VALUES ($1)",
      "ROLLBACK TO SAVEPOINT lesto_batch_N",
      "RELEASE SAVEPOINT lesto_batch_N",
      "COMMIT",
    ]);
  });

  it("two overlapping batches on the one connection run one span after the other", async () => {
    const { connection, calls } = makeHyperdrive((text) => {
      if (text.startsWith("INSERT INTO b2")) throw new Error("b2 failed");

      return { rows: [], rowCount: 1 };
    });
    const db = hyperdriveToSqlDatabase(connection);
    const write = (sql: string) => ({ sql, params: [], returns: "changes" as const });

    const first = db.batch([
      write("INSERT INTO a1 DEFAULT VALUES"),
      write("INSERT INTO a2 DEFAULT VALUES"),
    ]);
    const second = db.batch([
      write("INSERT INTO b1 DEFAULT VALUES"),
      write("INSERT INTO b2 DEFAULT VALUES"),
    ]);

    await expect(first).resolves.toHaveLength(2);
    await expect(second).rejects.toThrow("b2 failed");

    expect(calls.map((c) => c.text)).toEqual([
      "BEGIN",
      "INSERT INTO a1 DEFAULT VALUES",
      "INSERT INTO a2 DEFAULT VALUES",
      "COMMIT",
      "BEGIN",
      "INSERT INTO b1 DEFAULT VALUES",
      "INSERT INTO b2 DEFAULT VALUES",
      "ROLLBACK",
    ]);
  });

  it("a transaction overlapping a batch also waits its turn", async () => {
    const { connection, calls } = makeHyperdrive(() => ({ rows: [], rowCount: 1 }));
    const db = hyperdriveToSqlDatabase(connection);

    const batched = db.batch([
      { sql: "INSERT INTO a DEFAULT VALUES", params: [], returns: "changes" },
    ]);
    const span = db.transaction((tx) => tx.exec("INSERT INTO b DEFAULT VALUES"));

    await Promise.all([batched, span]);

    expect(calls.map((c) => c.text)).toEqual([
      "BEGIN",
      "INSERT INTO a DEFAULT VALUES",
      "COMMIT",
      "BEGIN",
      "INSERT INTO b DEFAULT VALUES",
      "COMMIT",
    ]);
  });
});
