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
