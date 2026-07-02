import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { adaptSyncSqlite } from "@lesto/db";
import type { SqlDatabase } from "@lesto/db";
import type { ShapeChange, ShapeDefinition } from "@lesto/live-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteLiveStore } from "../src/index";

/**
 * A real `SqlDatabase` over better-sqlite3 (the repo's canonical test engine), so these tests
 * exercise genuine SQLite atomicity — the store's whole guarantee. It is deliberately NOT built
 * on `@lesto/runtime`'s `openSqlite`: importing that barrel drags the JSX renderer into this
 * non-JSX package's typecheck. The engine-specific `exec`/`prepare` pair is wrapped by the shared
 * {@link adaptSyncSqlite} — the same FIFO `BEGIN`…`COMMIT`/`ROLLBACK` adapter `openSqlite` and the
 * OPFS driver both use — so an async write callback cannot interleave a second `BEGIN` on the one
 * connection, and this fixture is now one caller of the transaction logic covered in `@lesto/db`.
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

  return { db: adaptSyncSqlite(statements), close: () => raw.close() };
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

/** An `insert` change for the durable-outbox tests below (the row's id IS its key). */
const insert = (key: string, rank: number): ShapeChange => ({
  op: "insert",
  key,
  row: { id: key, rank },
});

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

  it("a throwing onError does not wedge the write chain (whenIdle still resolves, tier still recovers)", async () => {
    const db = freshDb();
    let fail = true;
    const onError = vi.fn(() => {
      throw new Error("onError blew up");
    });

    const store = await createSqliteLiveStore({
      def,
      db: withFaultyCursorWrite(db, () => fail),
      onError,
    });

    store.applyChange({ op: "insert", key: "a", row: { id: "a", rank: 1 } }, "v1:s:1:1");
    // Contract: whenIdle NEVER rejects — even when the failure handler itself throws.
    await expect(store.whenIdle()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);

    // The chain was not stranded by the throw: a full-slice write still thaws, and a later
    // incremental write lands.
    fail = false;
    store.applySnapshot([{ id: "d", rank: 4 }], "v1:s:1:9");
    await store.whenIdle();
    store.applyChange({ op: "insert", key: "e", row: { id: "e", rank: 5 } }, "v1:s:1:10");
    await store.whenIdle();

    expect((await createSqliteLiveStore({ def, db })).getRows()).toEqual([
      { id: "d", rank: 4 },
      { id: "e", rank: 5 },
    ]);
  });

  it("a snapshot carrying a duplicate key is last-wins durably, not a frozen tier", async () => {
    const db = freshDb();
    const store = await createSqliteLiveStore({ def, db });

    // The mirror dedups (a Map, last-wins); the durable upsert must match rather than throw a PK
    // violation that would freeze the tier and diverge durable from mirror on the same input.
    store.applySnapshot(
      [
        { id: "a", rank: 1 },
        { id: "a", rank: 9 },
      ],
      "v1:s:1:1",
    );
    await store.whenIdle();
    expect(store.getRows()).toEqual([{ id: "a", rank: 9 }]);
    expect((await createSqliteLiveStore({ def, db })).getRows()).toEqual([{ id: "a", rank: 9 }]);

    // Not frozen: a later incremental write still lands.
    store.applyChange({ op: "insert", key: "b", row: { id: "b", rank: 2 } }, "v1:s:1:2");
    await store.whenIdle();
    // Sorted by the shape's `rank` asc: b (2) then a (9).
    expect((await createSqliteLiveStore({ def, db })).getRows()).toEqual([
      { id: "b", rank: 2 },
      { id: "a", rank: 9 },
    ]);
  });

  it("isolates two shapes on the SAME table by shapeId", async () => {
    const db = freshDb();
    const shapeLo: ShapeDefinition = { ...def, where: [{ column: "rank", op: "lt", value: 10 }] };
    const shapeHi: ShapeDefinition = { ...def, where: [{ column: "rank", op: "gte", value: 10 }] };

    const lo = await createSqliteLiveStore({ def: shapeLo, db });
    const hi = await createSqliteLiveStore({ def: shapeHi, db });
    lo.applySnapshot([{ id: "a", rank: 1 }], "v1:s:1:1");
    hi.applySnapshot([{ id: "b", rank: 20 }], "v1:s:1:2");
    await lo.whenIdle();
    await hi.whenIdle();

    // Each shape reloads only its own rows + cursor, even sharing one table in the shared tables.
    const loReload = await createSqliteLiveStore({ def: shapeLo, db });
    const hiReload = await createSqliteLiveStore({ def: shapeHi, db });
    expect(loReload.getRows()).toEqual([{ id: "a", rank: 1 }]);
    expect(loReload.getCursor()).toBe("v1:s:1:1");
    expect(hiReload.getRows()).toEqual([{ id: "b", rank: 20 }]);
    expect(hiReload.getCursor()).toBe("v1:s:1:2");
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

describe("createSqliteLiveStore — durable offline-write outbox (Inc6)", () => {
  it("persists appended entries and reloads them in submission order", async () => {
    const db = freshDb();
    const store = await createSqliteLiveStore({ def, db });

    store.outbox?.append({
      id: "m1",
      name: "addPost",
      input: { rank: 1 },
      optimistic: insert("x", 1),
    });
    // A no-arg mutation's `undefined` input round-trips to `null` — exactly what its replayed POST
    // body would carry (the mutation client also serializes `input ?? null`).
    store.outbox?.append({
      id: "m2",
      name: "delPost",
      input: undefined,
      optimistic: { op: "delete", key: "y" },
    });
    await store.whenIdle();

    const reloaded = await createSqliteLiveStore({ def, db });

    expect(reloaded.outbox?.load()).toEqual([
      { id: "m1", name: "addPost", input: { rank: 1 }, optimistic: insert("x", 1), held: false },
      {
        id: "m2",
        name: "delPost",
        input: null,
        optimistic: { op: "delete", key: "y" },
        held: false,
      },
    ]);
  });

  it("removes an entry durably, leaving the rest in order", async () => {
    const db = freshDb();
    const store = await createSqliteLiveStore({ def, db });

    store.outbox?.append({ id: "m1", name: "n", input: 1, optimistic: insert("x", 1) });
    store.outbox?.append({ id: "m2", name: "n", input: 2, optimistic: insert("z", 2) });
    await store.whenIdle();

    store.outbox?.remove("m1");
    await store.whenIdle();

    const reloaded = await createSqliteLiveStore({ def, db });
    expect(reloaded.outbox?.load().map((e) => e.id)).toEqual(["m2"]);
  });

  it("a resubmit of the same id upserts rather than duplicating", async () => {
    const db = freshDb();
    const store = await createSqliteLiveStore({ def, db });

    store.outbox?.append({ id: "m1", name: "n", input: 1, optimistic: insert("x", 1) });
    store.outbox?.append({
      id: "m1",
      name: "n2",
      input: 2,
      optimistic: { op: "update", key: "x", row: { id: "x", rank: 9 } },
    });
    await store.whenIdle();

    const reloaded = await createSqliteLiveStore({ def, db });
    expect(reloaded.outbox?.load()).toEqual([
      {
        id: "m1",
        name: "n2",
        input: 2,
        optimistic: { op: "update", key: "x", row: { id: "x", rank: 9 } },
        held: false,
      },
    ]);
  });

  it("isolates the outbox per shape, and whenIdle awaits the outbox writes", async () => {
    const db = freshDb();
    const other: ShapeDefinition = { ...def, table: "comments" };
    const posts = await createSqliteLiveStore({ def, db });
    const comments = await createSqliteLiveStore({ def: other, db });

    posts.outbox?.append({ id: "p1", name: "n", input: null, optimistic: insert("p", 1) });
    comments.outbox?.append({ id: "c1", name: "n", input: null, optimistic: insert("c", 1) });
    await posts.whenIdle();
    await comments.whenIdle();

    expect((await createSqliteLiveStore({ def, db })).outbox?.load().map((e) => e.id)).toEqual([
      "p1",
    ]);
    expect(
      (await createSqliteLiveStore({ def: other, db })).outbox?.load().map((e) => e.id),
    ).toEqual(["c1"]);
  });

  it("applyOptimistic overlays the durable store WITHOUT persisting to the rows tier", async () => {
    const db = freshDb();
    const store = await createSqliteLiveStore({ def, db });
    store.applySnapshot([{ id: "a", rank: 1 }], "v1:s:1:1");
    await store.whenIdle();

    store.applyOptimistic("m1", insert("b", 2));
    expect(store.getRows()).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ]);
    await store.whenIdle();

    // The optimistic row is overlay-only: the durable ROWS table still holds just the authorized
    // snapshot (durability of the write comes from the outbox log, rebuilt into the overlay on
    // reload — not the rows tier). With no outbox entry, a reload does not resurrect it.
    const reloaded = await createSqliteLiveStore({ def, db });
    expect(reloaded.getRows()).toEqual([{ id: "a", rank: 1 }]);

    store.clearOptimistic("m1");
    expect(store.getRows()).toEqual([{ id: "a", rank: 1 }]);
  });

  it("an outbox write bypasses the rows/cursor freeze — a frozen tier never drops an offline write", async () => {
    const db = freshDb();
    let fail = true;
    const onError = vi.fn();
    const store = await createSqliteLiveStore({
      def,
      db: withFaultyCursorWrite(db, () => fail),
      onError,
    });

    // Freeze the rows tier with a failed incremental write.
    store.applyChange(insert("a", 1), "v1:s:1:1");
    await store.whenIdle();
    expect(onError).toHaveBeenCalledTimes(1);

    // While frozen, a durable outbox append MUST still land (it touches neither rows nor cursor, so
    // it cannot violate the (rows, cursor) invariant the freeze protects) — losing it would defeat
    // the whole "an offline write survives reload" guarantee.
    store.outbox?.append({ id: "m1", name: "n", input: 1, optimistic: insert("x", 1) });
    await store.whenIdle();

    fail = false;
    const reloaded = await createSqliteLiveStore({ def, db });
    expect(reloaded.outbox?.load().map((e) => e.id)).toEqual(["m1"]);
  });

  it("a failed outbox write is reported and never rejects whenIdle", async () => {
    const onError = vi.fn();
    const store = await createSqliteLiveStore({
      def,
      db: withFaultyWrite(freshDb(), "lesto_live_outbox", () => true),
      onError,
    });

    store.outbox?.append({ id: "m1", name: "n", input: 1, optimistic: insert("x", 1) });

    await expect(store.whenIdle()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed outbox write when no onError is given (no unhandled rejection)", async () => {
    const store = await createSqliteLiveStore({
      def,
      db: withFaultyWrite(freshDb(), "lesto_live_outbox", () => true),
    });

    store.outbox?.append({ id: "m1", name: "n", input: 1, optimistic: insert("x", 1) });

    await expect(store.whenIdle()).resolves.toBeUndefined();
  });

  it("markHeld flips an entry to held; a reload rebuilds only that one as held (L-436724ba)", async () => {
    const db = freshDb();
    const store = await createSqliteLiveStore({ def, db });

    store.outbox?.append({ id: "m1", name: "n", input: 1, optimistic: insert("x", 1) });
    store.outbox?.append({ id: "m2", name: "n", input: 2, optimistic: insert("z", 2) });
    store.outbox?.markHeld("m1"); // m1 acked → held; m2 still pending
    await store.whenIdle();

    const reloaded = await createSqliteLiveStore({ def, db });
    expect(reloaded.outbox?.load()).toEqual([
      { id: "m1", name: "n", input: 1, optimistic: insert("x", 1), held: true },
      { id: "m2", name: "n", input: 2, optimistic: insert("z", 2), held: false },
    ]);
  });

  it("adds the `held` column to a pre-L-436724ba outbox table (idempotent migration)", async () => {
    const db = freshDb();

    // A database created before `held` existed: the original Inc6 outbox schema, no `held` column.
    await db.exec(
      "CREATE TABLE lesto_live_outbox (shape TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, " +
        "input TEXT NOT NULL, optimistic TEXT NOT NULL, PRIMARY KEY (shape, id));",
    );

    // Opening the store migrates the table (adds `held`), so the outbox works end to end — an append
    // + markHeld + reload round-trips the new column that the old schema lacked.
    const store = await createSqliteLiveStore({ def, db });
    store.outbox?.append({ id: "m1", name: "n", input: 1, optimistic: insert("x", 1) });
    store.outbox?.markHeld("m1");
    await store.whenIdle();

    // Re-opening finds the column already present — the migration is a no-op the second time.
    const reloaded = await createSqliteLiveStore({ def, db });
    expect(reloaded.outbox?.load()).toEqual([
      { id: "m1", name: "n", input: 1, optimistic: insert("x", 1), held: true },
    ]);
  });
});

describe("createSqliteLiveStore — hydration runs inside the write FIFO", () => {
  it("a hydration issued while a write transaction is open does not interleave into that open span", async () => {
    const db = freshDb();
    const log: string[] = [];
    const entered = deferred<void>();
    const release = deferred<void>();

    // Shape A's connection: gate its cursor-write statement so its transaction stays open
    // (BEGIN executed, COMMIT withheld) until the test explicitly releases it — simulating "a
    // write transaction in flight" for as long as the test needs.
    const dbA = withCallLog(db, log, "A", {
      sqlIncludes: "lesto_live_cursor",
      onEnter: () => entered.resolve(),
      release: release.promise,
    });
    const dbB = withCallLog(db, log, "B");

    const storeA = await createSqliteLiveStore({ def, db: dbA });

    // Fire A's write. It reaches, then pauses on, the gated cursor UPSERT — its transaction is
    // now genuinely open (a real BEGIN has run on the shared connection, no COMMIT yet).
    storeA.applyChange({ op: "insert", key: "a", row: { id: "a", rank: 1 } }, "v1:s:1:1");
    await entered.promise;

    // Hydrate a SECOND shape over the very same shared connection while A's write transaction
    // is still open. Before the Task 3 fix, this shape's schema install + reads ran as bare
    // `db.exec` / `db.prepare` calls with no FIFO queuing, so they could run immediately — right
    // here, spliced into A's open span. After the fix they are wrapped in their own single
    // `db.transaction` span, which shares A's connection-level FIFO chain (`openTestDb`'s
    // `chain`, mirroring the real adapters) and cannot even begin until A's transaction settles.
    const otherDef: ShapeDefinition = { ...def, table: "comments" };
    const hydrateB = createSqliteLiveStore({ def: otherDef, db: dbB });

    // Give any wrongly-unserialized hydration code every chance to run before A is released.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Structural, not timing-dependent: B cannot have logged anything yet, because a properly
    // FIFO'd hydration transaction cannot start while the chain is still parked on A's open one.
    expect(log.some((entry) => entry.startsWith("B:"))).toBe(false);

    release.resolve();
    await storeA.whenIdle();
    await hydrateB;

    // B's very first logged statement happened strictly after A's gated write resumed (and, by
    // construction of `db.transaction`, after A's COMMIT) — never spliced into the middle of it.
    const resumeIndex = log.indexOf("A:gate-resume");
    const firstBIndex = log.findIndex((entry) => entry.startsWith("B:"));

    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(firstBIndex).toBeGreaterThan(resumeIndex);
  });
});

/** A promise plus its externally-callable `resolve` — for hand-synchronizing a paused async step. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

/**
 * Wrap a real `SqlDatabase` so every `exec` / `prepare().run|get|all` call — whether issued at
 * the top level or from inside a `transaction` span — appends a `"<label>:<op>"` entry to `log`,
 * in real execution order. When `gate` is given, the FIRST `run()` call whose SQL includes
 * `gate.sqlIncludes` logs `"<label>:gate-enter"`, invokes `gate.onEnter()`, then awaits
 * `gate.release` before logging `"<label>:gate-resume"` and actually running — pausing an
 * otherwise-ordinary write mid-transaction so a test can prove a concurrent `db.transaction`
 * call (e.g. another shape's hydration) cannot interleave into it. Deliberately does not gate a
 * `get`/`all` (a read), so hydration's own SELECTs — which also touch `lesto_live_cursor` — are
 * never mistaken for the write this is meant to pause.
 */
function withCallLog(
  db: SqlDatabase,
  log: string[],
  label: string,
  gate?: { sqlIncludes: string; onEnter: () => void; release: Promise<void> },
): SqlDatabase {
  let gated = false;

  const wrap = (target: SqlDatabase): SqlDatabase => ({
    exec: async (sql) => {
      log.push(`${label}:exec`);

      return target.exec(sql);
    },
    prepare: (sql) => {
      const stmt = target.prepare(sql);

      return {
        run: async (params) => {
          if (!gated && gate !== undefined && sql.includes(gate.sqlIncludes)) {
            gated = true;
            log.push(`${label}:gate-enter`);
            gate.onEnter();
            await gate.release;
            log.push(`${label}:gate-resume`);
          } else {
            log.push(`${label}:run`);
          }

          return stmt.run(params);
        },
        get: async (params) => {
          log.push(`${label}:get`);

          return stmt.get(params);
        },
        all: async (params) => {
          log.push(`${label}:all`);

          return stmt.all(params);
        },
      };
    },
    transaction: (fn) => target.transaction((tx) => fn(wrap(tx))),
  });

  return wrap(db);
}

/**
 * Wrap a real `SqlDatabase` so any prepared statement whose SQL includes `sqlMatch` throws on
 * `run()` while `shouldFail()` — a targeted write fault. The wrap reaches into the transaction's
 * `tx` handle (where the store's writes run), so the surrounding real transaction rolls back
 * atomically. {@link withFaultyCursorWrite} is the `"lesto_live_cursor"` specialization.
 */
function withFaultyWrite(
  db: SqlDatabase,
  sqlMatch: string,
  shouldFail: () => boolean,
): SqlDatabase {
  const wrapPrepare =
    (target: SqlDatabase): SqlDatabase["prepare"] =>
    (sql) => {
      const stmt = target.prepare(sql);

      if (!sql.includes(sqlMatch)) return stmt;

      return {
        ...stmt,
        run: async (params) => {
          if (shouldFail()) throw new Error(`boom: ${sqlMatch} write failed`);

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

/** The `"lesto_live_cursor"` specialization of {@link withFaultyWrite} — the torn-write fault. */
function withFaultyCursorWrite(db: SqlDatabase, shouldFail: () => boolean): SqlDatabase {
  return withFaultyWrite(db, "lesto_live_cursor", shouldFail);
}
