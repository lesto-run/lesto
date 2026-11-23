import { AsyncLocalStorage } from "node:async_hooks";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { adaptSyncSqlite } from "../src/sync-sqlite";
import type { SqlDatabase } from "../src/sql";

/**
 * A tiny fake synchronous SQLite-like handle — records every `exec` call (in order) so a test
 * can assert BEGIN/COMMIT/ROLLBACK sequencing directly, without a real engine in the way. Its
 * `prepare` is never exercised by {@link adaptSyncSqlite} itself (only spread through to the
 * tx handle), so it is a minimal stub.
 */
function createFakeHandle(options: { failRollback?: boolean } = {}): {
  calls: string[];
  statements: Pick<SqlDatabase, "exec" | "prepare">;
} {
  const calls: string[] = [];

  const statements: Pick<SqlDatabase, "exec" | "prepare"> = {
    exec: async (sql) => {
      calls.push(sql);

      if (sql === "ROLLBACK" && options.failRollback) {
        throw new Error("rollback failed");
      }
    },
    prepare: () => ({
      run: async () => ({ changes: 0 }),
      get: async () => undefined,
      all: async () => [],
    }),
  };

  return { calls, statements };
}

describe("adaptSyncSqlite", () => {
  it("commits on resolve, in BEGIN/COMMIT order", async () => {
    const { calls, statements } = createFakeHandle();
    const db = adaptSyncSqlite(statements);

    await expect(db.transaction(async () => "ok")).resolves.toBe("ok");
    expect(calls).toEqual(["BEGIN", "COMMIT"]);
  });

  it("rolls back and re-throws the ORIGINAL error on reject", async () => {
    const { calls, statements } = createFakeHandle();
    const db = adaptSyncSqlite(statements);
    const failure = new Error("boom");

    await expect(
      db.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("does not mask the original error when ROLLBACK itself fails", async () => {
    const { calls, statements } = createFakeHandle({ failRollback: true });
    const db = adaptSyncSqlite(statements);
    const failure = new Error("boom");

    await expect(
      db.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("a rejected span does not poison the chain — the next span still runs and commits", async () => {
    const { calls, statements } = createFakeHandle();
    const db = adaptSyncSqlite(statements);
    const failure = new Error("boom");

    await expect(
      db.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    await expect(db.transaction(async () => "next")).resolves.toBe("next");

    expect(calls).toEqual(["BEGIN", "ROLLBACK", "BEGIN", "COMMIT"]);
  });

  it("composes a nested tx.transaction(inner) FLAT — a single BEGIN/COMMIT pair", async () => {
    const { calls, statements } = createFakeHandle();
    const db = adaptSyncSqlite(statements);

    const result = await db.transaction(async (tx) => tx.transaction(async () => "nested-ok"));

    expect(result).toBe("nested-ok");
    expect(calls).toEqual(["BEGIN", "COMMIT"]);
  });

  it("stamps the sqlite dialect marker on the handle AND on the tx handle", async () => {
    const { statements } = createFakeHandle();
    const db = adaptSyncSqlite(statements);

    // The marker is what lets a consumer (the queue, createDb) infer the engine
    // instead of trusting a caller-remembered flag — it must survive into the
    // tx-scoped handle too, which is itself a SqlDatabase.
    expect(db.dialect).toBe("sqlite");

    await db.transaction(async (tx) => {
      expect(tx.dialect).toBe("sqlite");
    });
  });

  it("serializes two overlapping transactions FIFO — the second never BEGINs before the first settles", async () => {
    const { calls, statements } = createFakeHandle();
    const db = adaptSyncSqlite(statements);
    const order: string[] = [];

    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = db.transaction(async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });

    const second = db.transaction(async () => {
      order.push("second:start");
    });

    // Flush pending microtasks without releasing the gate: the second span must still be
    // queued behind the first — its BEGIN has not run yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    expect(calls).toEqual(["BEGIN"]);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(calls).toEqual(["BEGIN", "COMMIT", "BEGIN", "COMMIT"]);
  });
});

/** A real in-memory better-sqlite3 engine behind {@link adaptSyncSqlite} — the runtime's shape. */
function realSqlite(withContext = false): { raw: Database.Database; db: SqlDatabase } {
  const raw = new Database(":memory:");

  const options = withContext ? { asyncContext: new AsyncLocalStorage<object>() } : {};

  const db = adaptSyncSqlite(
    {
      exec: async (sql) => {
        raw.exec(sql);
      },
      prepare: (sql) => {
        const statement = raw.prepare(sql);

        return {
          run: async (params = []) => statement.run(...(params as never[])),
          get: async (params = []) => statement.get(...(params as never[])),
          all: async (params = []) => statement.all(...(params as never[])),
        };
      },
    },
    options,
  );

  raw.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, state TEXT)");

  return { raw, db };
}

describe("adaptSyncSqlite batch", () => {
  it("runs the statements in ONE BEGIN/COMMIT span, in order, with per-statement results", async () => {
    const { raw, db } = realSqlite();

    const results = await db.batch([
      { sql: "INSERT INTO items (id, name) VALUES (?, ?)", params: [1, "a"], returns: "changes" },
      { sql: "INSERT INTO items (id, name) VALUES (?, ?)", params: [2, "b"], returns: "changes" },
      { sql: "UPDATE items SET state = ?", params: ["x"], returns: "changes" },
      {
        sql: "INSERT INTO items (id, name) VALUES (?, ?) RETURNING id, name",
        params: [3, "c"],
        returns: "rows",
      },
      { sql: "SELECT id FROM items ORDER BY id", params: [], returns: "rows" },
    ]);

    expect(results).toEqual([
      { returns: "changes", changes: 1 },
      { returns: "changes", changes: 1 },
      { returns: "changes", changes: 2 },
      { returns: "rows", rows: [{ id: 3, name: "c" }] },
      { returns: "rows", rows: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    ]);

    raw.close();
  });

  it("all-or-nothing: a constraint violation mid-batch leaves no earlier write", async () => {
    const { raw, db } = realSqlite();

    await expect(
      db.batch([
        { sql: "INSERT INTO items (id, name) VALUES (1, 'a')", params: [], returns: "changes" },
        { sql: "INSERT INTO items (id, name) VALUES (2, 'a')", params: [], returns: "changes" },
        { sql: "INSERT INTO items (id, name) VALUES (3, 'c')", params: [], returns: "changes" },
      ]),
    ).rejects.toThrow(/UNIQUE/);

    expect(raw.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });

    raw.close();
  });

  it("a changes()- or EXISTS-gated statement sees the earlier write in the same batch", async () => {
    const { raw, db } = realSqlite();

    raw.exec("INSERT INTO items (id, name, state) VALUES (1, 'a', 'pending')");

    const claim = {
      sql: "UPDATE items SET state = 'taken' WHERE id = 1 AND state = 'pending'",
      params: [],
      returns: "changes" as const,
    };
    // A guard that FAILS (NOT NULL) when the claim before it changed no row.
    const guard = {
      sql: "INSERT INTO items (id, name) SELECT 99, NULL WHERE changes() = 0",
      params: [],
      returns: "changes" as const,
    };
    // Writes only when the earlier write in this batch is visible.
    const follow = {
      sql: "INSERT INTO items (id, name) SELECT 2, 'seen' WHERE EXISTS (SELECT 1 FROM items WHERE state = 'taken')",
      params: [],
      returns: "changes" as const,
    };

    await expect(db.batch([claim, guard, follow])).resolves.toEqual([
      { returns: "changes", changes: 1 },
      { returns: "changes", changes: 0 },
      { returns: "changes", changes: 1 },
    ]);

    // The second identical claim changes nothing, so the guard fails and the batch rolls back.
    await expect(
      db.batch([
        { sql: "INSERT INTO items (id, name) VALUES (3, 'c')", params: [], returns: "changes" },
        claim,
        guard,
      ]),
    ).rejects.toThrow(/NOT NULL/);

    expect(raw.prepare("SELECT id FROM items ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);

    raw.close();
  });

  it("an empty batch resolves [] and never opens a span", async () => {
    const { calls, statements } = createFakeHandle();
    const db = adaptSyncSqlite(statements);

    await expect(db.batch([])).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it("a batch on the tx handle runs inside a SAVEPOINT of the open span (no second BEGIN)", async () => {
    const { calls, statements } = createFakeHandle();
    const db = adaptSyncSqlite(statements);

    await db.transaction((tx) =>
      tx.batch([{ sql: "UPDATE t SET a = 1", params: [], returns: "changes" }]),
    );

    expect(calls).toEqual([
      "BEGIN",
      expect.stringMatching(/^SAVEPOINT lesto_batch_\d+$/),
      expect.stringMatching(/^RELEASE SAVEPOINT lesto_batch_\d+$/),
      "COMMIT",
    ]);
  });

  it("a failed tx.batch that the caller catches leaves no write when the transaction commits", async () => {
    const { raw, db } = realSqlite();

    await db.transaction(async (tx) => {
      await tx.prepare("INSERT INTO items (id, name) VALUES (5, 'outer')").run();

      await expect(
        tx.batch([
          { sql: "INSERT INTO items (id, name) VALUES (1, 'a')", params: [], returns: "changes" },
          { sql: "INSERT INTO items (id, name) VALUES (2, 'a')", params: [], returns: "changes" },
        ]),
      ).rejects.toThrow(/UNIQUE/);
    });

    // The outer write commits; the batch's first insert rolled back to its savepoint.
    expect(raw.prepare("SELECT id FROM items ORDER BY id").all()).toEqual([{ id: 5 }]);

    raw.close();
  });

  it("an empty tx.batch sends nothing", async () => {
    const { calls, statements } = createFakeHandle();
    const db = adaptSyncSqlite(statements);

    await expect(db.transaction((tx) => tx.batch([]))).resolves.toEqual([]);
    expect(calls).toEqual(["BEGIN", "COMMIT"]);
  });

  it("a failing ROLLBACK TO does not mask the batch's original error", async () => {
    const failure = new Error("constraint");
    const calls: string[] = [];
    const db = adaptSyncSqlite({
      exec: async (sql) => {
        calls.push(sql);

        if (sql.startsWith("ROLLBACK TO")) throw new Error("rollback failed");
      },
      prepare: () => ({
        run: async () => {
          throw failure;
        },
        get: async () => undefined,
        all: async () => [],
      }),
    });

    await expect(
      db.transaction((tx) =>
        tx.batch([{ sql: "INSERT INTO t VALUES (1)", params: [], returns: "changes" }]),
      ),
    ).rejects.toBe(failure);

    expect(calls.map((sql) => sql.replace(/\d+$/, "N"))).toEqual([
      "BEGIN",
      "SAVEPOINT lesto_batch_N",
      "ROLLBACK TO SAVEPOINT lesto_batch_N",
      "ROLLBACK",
    ]);
  });

  it("a root-handle write issued during an open span waits for it — the span's rollback cannot erase it", async () => {
    const { raw, db } = realSqlite();

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let entered: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const span = db.transaction(async (tx) => {
      await tx.prepare("INSERT INTO items (id, name) VALUES (1, 'span')").run();
      entered?.();
      await gate;

      throw new Error("boom");
    });

    // Issued only once the span's BEGIN has run and its first write landed.
    await opened;
    const solo = db.prepare("INSERT INTO items (id, name) VALUES (2, 'solo')").run();
    const soloExec = db.exec("INSERT INTO items (id, name) VALUES (3, 'exec')");

    await Promise.resolve();
    await Promise.resolve();
    release?.();

    await expect(span).rejects.toThrow("boom");
    await expect(solo).resolves.toMatchObject({ changes: 1 });
    await soloExec;

    expect(raw.prepare("SELECT id FROM items ORDER BY id").all()).toEqual([{ id: 2 }, { id: 3 }]);
    await expect(db.prepare("SELECT id FROM items WHERE id = 2").get()).resolves.toEqual({ id: 2 });
    await expect(db.prepare("SELECT id FROM items").all()).resolves.toHaveLength(2);

    raw.close();
  });

  it("a changes() guard in a span reads its own claim, never an interleaved root write", async () => {
    const { raw, db } = realSqlite();

    raw.exec("INSERT INTO items (id, name, state) VALUES (1, 'a', 'taken')");

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let entered: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const span = db.transaction(async (tx) => {
      // Claims nothing: the row is already taken.
      await tx.prepare("UPDATE items SET state = 'taken' WHERE state = 'pending'").run();
      entered?.();
      await gate;
      // Must fail, because the claim above changed no row.
      await tx.prepare("INSERT INTO items (id, name) SELECT 99, NULL WHERE changes() = 0").run();
    });

    await opened;
    const solo = db.prepare("INSERT INTO items (id, name) VALUES (2, 'solo')").run();

    await Promise.resolve();
    await Promise.resolve();
    release?.();

    await expect(span).rejects.toThrow(/NOT NULL/);
    await solo;

    raw.close();
  });

  it("queues FIFO behind an open transaction — its BEGIN waits for the span to settle", async () => {
    const { calls, statements } = createFakeHandle();
    const db = adaptSyncSqlite(statements);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = db.transaction(() => gate);
    const batched = db.batch([{ sql: "UPDATE t SET a = 1", params: [], returns: "changes" }]);

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["BEGIN"]);

    release?.();
    await Promise.all([first, batched]);

    expect(calls).toEqual(["BEGIN", "COMMIT", "BEGIN", "COMMIT"]);
  });
});

/** A one-row insert into `items`. */
function insert(id: number): string {
  return `INSERT INTO items (id, name) VALUES (${id}, 'n${id}')`;
}

/** Every `items` id, in order. */
function ids(raw: Database.Database): unknown[] {
  return raw.prepare("SELECT id FROM items ORDER BY id").all();
}

describe("adaptSyncSqlite — a root statement inside its own span", () => {
  it("rejects every root operation with DB_ROOT_STATEMENT_IN_SPAN, and the span still commits", async () => {
    const { raw, db } = realSqlite(true);
    const refused = { code: "DB_ROOT_STATEMENT_IN_SPAN" };

    await db.transaction(async (tx) => {
      await tx.prepare(insert(1)).run();

      await expect(db.prepare(insert(2)).run()).rejects.toMatchObject({
        ...refused,
        details: { operation: "run" },
      });
      await expect(db.prepare("SELECT 1").get()).rejects.toMatchObject(refused);
      await expect(db.prepare("SELECT 1").all()).rejects.toMatchObject(refused);
      await expect(db.exec(insert(3))).rejects.toMatchObject(refused);
      await expect(db.transaction(async () => 1)).rejects.toMatchObject(refused);
      await expect(
        db.batch([{ sql: insert(4), params: [], returns: "changes" }]),
      ).rejects.toMatchObject({ ...refused, details: { operation: "batch" } });

      await tx.prepare(insert(5)).run();
    });

    expect(ids(raw)).toEqual([{ id: 1 }, { id: 5 }]);

    raw.close();
  });

  it("refuses inside a batch's span too, and the span still rolls back when its callback throws", async () => {
    const { raw, db } = realSqlite(true);

    await expect(
      db.transaction(async (tx) => {
        await tx.batch([{ sql: insert(1), params: [], returns: "changes" }]);

        await db.prepare(insert(2)).run();
      }),
    ).rejects.toMatchObject({ code: "DB_ROOT_STATEMENT_IN_SPAN" });

    expect(ids(raw)).toEqual([]);

    // The queue is free again: the root handle works once the span has ended.
    await db.prepare(insert(3)).run();
    expect(ids(raw)).toEqual([{ id: 3 }]);

    raw.close();
  });

  it("a concurrent caller outside the span still waits its turn and succeeds", async () => {
    const { raw, db } = realSqlite(true);

    let entered: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const span = db.transaction(async (tx) => {
      await tx.prepare(insert(1)).run();
      entered?.();
      await gate;
    });

    await opened;
    const outside = db.prepare(insert(2)).run();
    const outsideBatch = db.batch([{ sql: insert(3), params: [], returns: "changes" }]);

    release?.();

    await span;
    await expect(outside).resolves.toMatchObject({ changes: 1 });
    await expect(outsideBatch).resolves.toEqual([{ returns: "changes", changes: 1 }]);
    expect(ids(raw)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

    raw.close();
  });

  it("nested tx-handle use still works inside the span", async () => {
    const { raw, db } = realSqlite(true);

    await db.transaction(async (tx) => {
      await tx.exec(insert(1));
      await tx.transaction((inner) => inner.prepare(insert(2)).run());
      await tx.batch([{ sql: insert(3), params: [], returns: "changes" }]);
    });

    expect(ids(raw)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

    raw.close();
  });

  it("a root statement inside ANOTHER handle's span is not refused", async () => {
    const first = realSqlite(true);
    const second = realSqlite(true);

    await first.db.transaction(async () => {
      await second.db.prepare(insert(1)).run();
    });

    expect(ids(second.raw)).toEqual([{ id: 1 }]);

    first.raw.close();
    second.raw.close();
  });

  it("without async context the guard is best-effort: the statement waits for its own span", async () => {
    const { raw, db } = realSqlite();
    let late: Promise<unknown> | undefined;

    await db.transaction(async (tx) => {
      await tx.prepare(insert(1)).run();

      // Not awaited: awaiting it here would wait for this very span forever.
      late = db.prepare(insert(2)).run();
    });

    await expect(late).resolves.toMatchObject({ changes: 1 });
    expect(ids(raw)).toEqual([{ id: 1 }, { id: 2 }]);

    raw.close();
  });
});
