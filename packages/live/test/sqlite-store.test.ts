import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import type { SqlDatabase } from "@lesto/db";
import type { ShapeDefinition } from "@lesto/live-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteLiveStore } from "../src/index";

/**
 * A real `SqlDatabase` over better-sqlite3 (the repo's canonical test engine), so these tests
 * exercise genuine SQLite atomicity — the store's whole guarantee. It is deliberately NOT built
 * on `@lesto/runtime`'s `openSqlite`: importing that barrel drags the JSX renderer into this
 * non-JSX package's typecheck. The FIFO transaction shim mirrors `openSqlite`'s so an async
 * write callback cannot interleave a second `BEGIN` on the one connection.
 */
function openTestDb(filename = ":memory:"): { db: SqlDatabase; close: () => void } {
  const raw = new Database(filename);

  const statements: Pick<SqlDatabase, "exec" | "prepare"> = {
    exec: async (sql) => {
      raw.exec(sql);
    },
    prepare: (sql) => {
      const stmt = raw.prepare(sql);

      return {
        run: async (params = []) => stmt.run(...params),
        get: async (params = []) => stmt.get(...params) ?? undefined,
        all: async (params = []) => stmt.all(...params) as unknown[],
      };
    },
  };

  let chain: Promise<unknown> = Promise.resolve();

  const db: SqlDatabase = {
    ...statements,
    transaction: async (fn) => {
      const run = chain.then(async () => {
        raw.exec("BEGIN");

        try {
          const tx: SqlDatabase = { ...statements, transaction: (inner) => inner(tx) };
          const out = await fn(tx);

          raw.exec("COMMIT");

          return out;
        } catch (error) {
          try {
            raw.exec("ROLLBACK");
          } catch {
            /* best-effort: a failed rollback must not mask the original error */
          }

          throw error;
        }
      });

      chain = run.then(
        () => undefined,
        () => undefined,
      );

      return run;
    },
  };

  return { db, close: () => raw.close() };
}

// A shape ordered by `rank` ascending (the key `id` is the final tiebreak), matching the
// in-memory store's tests so both prove the same total-order + stable-reference contract.
const def: ShapeDefinition = {
  table: "posts",
  key: "id",
  columns: ["id", "rank"],
  where: [],
  orderBy: { column: "rank", direction: "asc" },
};

// Every opened engine, torn down after each test so no connection leaks between them.
const opened: Array<() => void> = [];

afterEach(() => {
  for (const close of opened.splice(0)) close();
});

/** Open a fresh in-memory SQLite as the async `SqlDatabase` seam, tracked for teardown. */
function freshDb(): SqlDatabase {
  const { db, close } = openTestDb();

  opened.push(close);

  return db;
}

describe("createSqliteLiveStore — durable rows + cursor", () => {
  it("applies a snapshot in the shape's total order and records its cursor", async () => {
    const store = await createSqliteLiveStore({ def, db: freshDb() });

    store.applySnapshot(
      [
        { id: "b", rank: 2 },
        { id: "a", rank: 1 },
      ],
      "v1:sysA:1:100",
    );
    await store.whenIdle();

    expect(store.getRows()).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ]);
    expect(store.getCursor()).toBe("v1:sysA:1:100");
  });

  it("inserts, updates, and deletes rows via applyChange, advancing the cursor each time", async () => {
    const store = await createSqliteLiveStore({ def, db: freshDb() });

    store.applyChange({ op: "insert", key: "a", row: { id: "a", rank: 2 } }, "v1:s:1:1");
    store.applyChange({ op: "insert", key: "b", row: { id: "b", rank: 1 } }, "v1:s:1:2");
    expect(store.getRows()).toEqual([
      { id: "b", rank: 1 },
      { id: "a", rank: 2 },
    ]);

    store.applyChange({ op: "update", key: "a", row: { id: "a", rank: 0 } }, "v1:s:1:3");
    expect(store.getRows()).toEqual([
      { id: "a", rank: 0 },
      { id: "b", rank: 1 },
    ]);

    store.applyChange({ op: "delete", key: "b" }, "v1:s:1:4");
    await store.whenIdle();

    expect(store.getRows()).toEqual([{ id: "a", rank: 0 }]);
    expect(store.getCursor()).toBe("v1:s:1:4");
  });

  it("survives reload: a new store over the same database re-reads rows and cursor", async () => {
    const db = freshDb();

    const first = await createSqliteLiveStore({ def, db });
    first.applySnapshot([{ id: "a", rank: 1 }], "v1:s:1:7");
    first.applyChange({ op: "insert", key: "b", row: { id: "b", rank: 2 } }, "v1:s:1:8");
    await first.whenIdle();

    // A "reload" is just a fresh store over the same durable engine — it must hydrate from it.
    const reloaded = await createSqliteLiveStore({ def, db });

    expect(reloaded.getRows()).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ]);
    expect(reloaded.getCursor()).toBe("v1:s:1:8");
  });

  it("survives a real reload across separate connections to the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lesto-live-"));
    const file = join(dir, "live.sqlite3");

    try {
      const a = openTestDb(file);
      const store = await createSqliteLiveStore({ def, db: a.db });
      store.applySnapshot([{ id: "x", rank: 5 }], "v1:s:2:42");
      await store.whenIdle();
      a.close();

      // A genuinely new connection to the persisted file — the reload the app sees on refresh.
      const b = openTestDb(file);
      opened.push(b.close);
      const reloaded = await createSqliteLiveStore({ def, db: b.db });

      expect(reloaded.getRows()).toEqual([{ id: "x", rank: 5 }]);
      expect(reloaded.getCursor()).toBe("v1:s:2:42");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps shapes isolated in the shared tables", async () => {
    const db = freshDb();
    const other: ShapeDefinition = { ...def, table: "comments" };

    const posts = await createSqliteLiveStore({ def, db });
    const comments = await createSqliteLiveStore({ def: other, db });

    posts.applySnapshot([{ id: "p", rank: 1 }], "v1:s:1:1");
    comments.applySnapshot([{ id: "c", rank: 1 }], "v1:s:1:2");
    await posts.whenIdle();
    await comments.whenIdle();

    // Each store reloads only its own shape's rows + cursor, never the other's.
    const postsReload = await createSqliteLiveStore({ def, db });
    const commentsReload = await createSqliteLiveStore({ def: other, db });

    expect(postsReload.getRows()).toEqual([{ id: "p", rank: 1 }]);
    expect(postsReload.getCursor()).toBe("v1:s:1:1");
    expect(commentsReload.getRows()).toEqual([{ id: "c", rank: 1 }]);
    expect(commentsReload.getCursor()).toBe("v1:s:1:2");
  });

  it("applyResync clears rows AND cursor, durably", async () => {
    const db = freshDb();

    const store = await createSqliteLiveStore({ def, db });
    store.applySnapshot([{ id: "a", rank: 1 }], "v1:s:1:1");
    await store.whenIdle();

    store.applyResync();
    await store.whenIdle();

    expect(store.getRows()).toEqual([]);
    expect(store.getCursor()).toBeUndefined();

    // The floor is durable: a reload sees no rows and no cursor (a fresh snapshot re-establishes both).
    const reloaded = await createSqliteLiveStore({ def, db });
    expect(reloaded.getRows()).toEqual([]);
    expect(reloaded.getCursor()).toBeUndefined();
  });

  it("a torn durable write rolls back BOTH the rows and the cursor — never cursor-ahead-of-rows", async () => {
    const db = freshDb();
    let fail = false;

    // Inject a fault into the cursor UPSERT so it throws mid-transaction, the way a crash would
    // interrupt the write between the row batch and the cursor. The whole transaction must roll
    // back, so neither the new row NOR the new cursor lands.
    const faulty = withFaultyCursorWrite(db, () => fail);

    const store = await createSqliteLiveStore({
      def,
      db: faulty,
      onError: vi.fn(),
    });

    store.applySnapshot([{ id: "a", rank: 1 }], "v1:s:1:1");
    await store.whenIdle();

    fail = true;
    store.applyChange({ op: "insert", key: "b", row: { id: "b", rank: 2 } }, "v1:s:1:2");
    await store.whenIdle();

    // A fresh store over the real (unwrapped) engine sees ONLY the committed snapshot: the failed
    // change advanced neither the rows (no `b`) nor the cursor (still `...:1`). That is the whole
    // point — a resume from the persisted cursor can never skip a row that was never persisted.
    const reloaded = await createSqliteLiveStore({ def, db });
    expect(reloaded.getRows()).toEqual([{ id: "a", rank: 1 }]);
    expect(reloaded.getCursor()).toBe("v1:s:1:1");
  });

  it("freezes after a failed write, dropping incremental writes, until a full-slice write restores it", async () => {
    const db = freshDb();
    let fail = true;
    const onError = vi.fn();

    const store = await createSqliteLiveStore({
      def,
      db: withFaultyCursorWrite(db, () => fail),
      onError,
    });

    // A failed incremental write freezes the tier and is reported.
    store.applyChange({ op: "insert", key: "a", row: { id: "a", rank: 1 } }, "v1:s:1:1");
    await store.whenIdle();
    expect(onError).toHaveBeenCalledTimes(1);

    // While frozen, a later incremental write is DROPPED — even though it would now succeed — so
    // the persisted cursor can never sit ahead of the row the failed write never wrote.
    fail = false;
    store.applyChange({ op: "insert", key: "b", row: { id: "b", rank: 2 } }, "v1:s:1:2");
    await store.whenIdle();
    expect((await createSqliteLiveStore({ def, db })).getRows()).toEqual([]);

    // A full-slice write (a snapshot) runs while frozen, restores a consistent slice, and thaws.
    store.applySnapshot([{ id: "d", rank: 4 }], "v1:s:1:9");
    await store.whenIdle();

    // Thawed: a subsequent incremental write lands again.
    store.applyChange({ op: "insert", key: "e", row: { id: "e", rank: 5 } }, "v1:s:1:10");
    await store.whenIdle();
    expect(onError).toHaveBeenCalledTimes(1);

    const reloaded = await createSqliteLiveStore({ def, db });
    expect(reloaded.getRows()).toEqual([
      { id: "d", rank: 4 },
      { id: "e", rank: 5 },
    ]);
    expect(reloaded.getCursor()).toBe("v1:s:1:10");
  });

  it("swallows a failed durable write when no onError is given (no unhandled rejection)", async () => {
    const store = await createSqliteLiveStore({
      def,
      db: withFaultyCursorWrite(freshDb(), () => true),
    });

    store.applyChange({ op: "insert", key: "a", row: { id: "a", rank: 1 } }, "v1:s:1:1");

    // The mirror stays correct for the live session even though durability failed…
    expect(store.getRows()).toEqual([{ id: "a", rank: 1 }]);
    // …and awaiting the chain resolves rather than rejecting.
    await expect(store.whenIdle()).resolves.toBeUndefined();
  });

  it("a malformed snapshot (a row missing its key) leaves the durable slice intact", async () => {
    const db = freshDb();

    const store = await createSqliteLiveStore({ def, db });
    store.applySnapshot([{ id: "a", rank: 1 }], "v1:s:1:1");
    await store.whenIdle();

    // The build throws BEFORE the mirror is swapped or a durable write is queued.
    expect(() => store.applySnapshot([{ rank: 2 }], "v1:s:1:2")).toThrow(/key column/);
    await store.whenIdle();

    expect(store.getRows()).toEqual([{ id: "a", rank: 1 }]);
    expect(store.getCursor()).toBe("v1:s:1:1");

    const reloaded = await createSqliteLiveStore({ def, db });
    expect(reloaded.getRows()).toEqual([{ id: "a", rank: 1 }]);
    expect(reloaded.getCursor()).toBe("v1:s:1:1");
  });

  it("getRows returns a stable reference between mutations and a fresh one after each", async () => {
    const store = await createSqliteLiveStore({ def, db: freshDb() });

    store.applySnapshot([{ id: "a", rank: 1 }], "v1:s:1:1");
    const first = store.getRows();
    expect(store.getRows()).toBe(first);

    store.applyChange({ op: "insert", key: "b", row: { id: "b", rank: 2 } }, "v1:s:1:2");
    const second = store.getRows();
    expect(second).not.toBe(first);
    expect(store.getRows()).toBe(second);
  });

  it("notifies subscribers on each mutation and stops after unsubscribe", async () => {
    const store = await createSqliteLiveStore({ def, db: freshDb() });
    const listener = vi.fn();

    const off = store.subscribe(listener);
    store.applySnapshot([{ id: "a", rank: 1 }], "v1:s:1:1");
    store.applyChange({ op: "insert", key: "b", row: { id: "b", rank: 2 } }, "v1:s:1:2");
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    store.applyResync();
    expect(listener).toHaveBeenCalledTimes(2);

    await store.whenIdle();
  });
});

/**
 * Wrap a real `SqlDatabase` so the `lesto_live_cursor` UPSERT throws while `shouldFail()` — the
 * torn-write fault. The wrap reaches into the transaction's `tx` handle (that is where the
 * store's cursor write runs), so the surrounding real transaction rolls back atomically.
 */
function withFaultyCursorWrite(db: SqlDatabase, shouldFail: () => boolean): SqlDatabase {
  const wrapPrepare =
    (target: SqlDatabase): SqlDatabase["prepare"] =>
    (sql) => {
      const stmt = target.prepare(sql);

      if (!sql.includes("lesto_live_cursor")) return stmt;

      return {
        ...stmt,
        run: async (params) => {
          if (shouldFail()) throw new Error("boom: cursor write failed");

          return stmt.run(params);
        },
      };
    };

  return {
    exec: (sql) => db.exec(sql),
    prepare: wrapPrepare(db),
    transaction: (fn) =>
      db.transaction((tx) => {
        const wrappedTx: SqlDatabase = {
          exec: (sql) => tx.exec(sql),
          prepare: wrapPrepare(tx),
          transaction: (inner) => inner(wrappedTx),
        };

        return fn(wrappedTx);
      }),
  };
}
