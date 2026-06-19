/**
 * `openSqlite` — the framework-owned SQLite driver seam (ADR 0006 Wave 1).
 *
 * Two engines, one adapter. The real path boots better-sqlite3 (the engine
 * Node/vitest loads) and exercises the full async `exec`/`prepare(run|get|all)`
 * surface, including the `params = []` defaults from both sides. The fallback
 * path injects async-wrapped sync fakes: better-sqlite3 "unavailable" (returns
 * `undefined`) so `bun:sqlite` is reached — the branch no Node test could
 * otherwise cover without loading `bun:sqlite`. When BOTH engines fail (the live
 * Node-without-Bun configuration), the fallback raises a coded
 * `RUNTIME_SQLITE_ENGINE_UNAVAILABLE` naming the real cause instead of leaking the
 * raw import error. The transaction verb is covered
 * on both its commit and rollback (including failed-rollback) branches, plus the
 * FIFO queue (concurrent transactions serialize; a rolled-back span does not
 * poison the chain) and flat nesting (an inner `tx.transaction` runs on the same
 * span; an inner throw rolls the whole span back).
 */

import { describe, expect, it, vi } from "vitest";

import { RuntimeError } from "../src/errors";
import { openSqlite } from "../src/sqlite";
import type { SqliteEngines, SqliteHandle } from "../src/sqlite";

describe("openSqlite", () => {
  it("boots the real engine and round-trips through the async param adapter", async () => {
    const { db, close } = await openSqlite();

    // exec: DDL with no params — now a Promise.
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

    // run WITH params (the array is spread onto the variadic driver call).
    const insert = db.prepare("INSERT INTO t (name) VALUES (?)");
    const result = await insert.run(["ada"]);

    expect(result.changes).toBe(1);
    expect(Number(result.lastInsertRowid)).toBe(1);

    // get WITH params.
    const byId = await db.prepare("SELECT name FROM t WHERE id = ?").get([1]);
    expect(byId).toEqual({ name: "ada" });

    // get and all with NO params — covers the `params = []` default branch.
    const count = await db.prepare("SELECT COUNT(*) AS n FROM t").get();
    expect(count).toEqual({ n: 1 });

    const all = await db.prepare("SELECT name FROM t").all();
    expect(all).toEqual([{ name: "ada" }]);

    // A miss normalizes to `undefined` (not the driver's `null`) — the contract
    // every SQL store guards on.
    const missing = await db.prepare("SELECT name FROM t WHERE id = ?").get([999]);
    expect(missing).toBeUndefined();

    close();
  });

  it("commits a transaction and returns fn's resolved value", async () => {
    const { db, close } = await openSqlite();

    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

    const out = await db.transaction(async (tx) => {
      await tx.prepare("INSERT INTO t (name) VALUES (?)").run(["committed"]);

      return "ok";
    });

    expect(out).toBe("ok");

    // The committed row survives the transaction.
    const rows = await db.prepare("SELECT name FROM t").all();
    expect(rows).toEqual([{ name: "committed" }]);

    close();
  });

  it("rolls back a transaction when fn throws, then re-raises", async () => {
    const { db, close } = await openSqlite();

    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

    const boom = new Error("boom");

    await expect(
      db.transaction(async (tx) => {
        await tx.prepare("INSERT INTO t (name) VALUES (?)").run(["doomed"]);

        throw boom;
      }),
    ).rejects.toBe(boom);

    // The insert was rolled back: the table is empty.
    const rows = await db.prepare("SELECT name FROM t").all();
    expect(rows).toEqual([]);

    close();
  });

  it("swallows a failing ROLLBACK and still re-raises the original error", async () => {
    // A fake handle whose ROLLBACK itself throws — the best-effort catch must not
    // mask fn's original error.
    const execed: string[] = [];

    const fakeHandle: SqliteHandle = {
      exec: (sql) => {
        if (sql === "ROLLBACK") {
          throw new Error("rollback failed");
        }

        execed.push(sql);

        return undefined;
      },
      prepare: () => ({
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => undefined,
        all: () => [],
      }),
      close: () => undefined,
    };

    const engines: SqliteEngines = {
      betterSqlite: () => fakeHandle,
      bunSqlite: () => Promise.resolve(fakeHandle),
    };

    const { db, close } = await openSqlite("ignored.db", engines);

    const original = new Error("original");

    await expect(
      db.transaction(async () => {
        throw original;
      }),
    ).rejects.toBe(original);

    // The FK pragma ran at open; BEGIN ran; the throwing ROLLBACK was swallowed
    // (so it isn't recorded); COMMIT never ran.
    expect(execed).toEqual(["PRAGMA foreign_keys = ON", "BEGIN"]);

    close();
  });

  it("falls back to bun:sqlite when better-sqlite3 is unavailable", async () => {
    const closed = vi.fn();

    // The fakes stay SYNC; the wrapper makes their terminal verbs async, so this
    // fallback branch stays covered under Node without loading bun:sqlite.
    const fakeHandle: SqliteHandle = {
      exec: () => undefined,
      prepare: () => ({
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => undefined,
        all: () => [],
      }),
      close: closed,
    };

    const engines: SqliteEngines = {
      betterSqlite: () => undefined, // native addon unavailable → fall back
      bunSqlite: () => Promise.resolve(fakeHandle),
    };

    const { db, close } = await openSqlite("ignored.db", engines);

    // The adapter wraps the fallback handle just the same — and asynchronously.
    expect(await db.prepare("SELECT 1").all()).toEqual([]);

    close();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("throws a coded RUNTIME_SQLITE_ENGINE_UNAVAILABLE when neither engine is usable", async () => {
    // The live Node-without-Bun failure: better-sqlite3's native addon didn't load
    // (→ undefined) AND bun:sqlite isn't resolvable (→ the import rejects). The
    // fallback must translate the cryptic import error into a clear, coded cause.
    const importBoom = new Error("Cannot find package 'bun:sqlite'");

    const engines: SqliteEngines = {
      betterSqlite: () => undefined, // native addon unavailable
      bunSqlite: () => Promise.reject(importBoom), // and we're not under Bun
    };

    const error = await openSqlite("ignored.db", engines).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("RUNTIME_SQLITE_ENGINE_UNAVAILABLE");
    // The message names the real culprit + remedy, not the leaked import error.
    expect((error as RuntimeError).message).toContain("better-sqlite3");
    expect((error as RuntimeError).message).toContain("npm rebuild better-sqlite3");
    expect((error as RuntimeError).message).toContain("bun:sqlite");
    // The raw import error rides along on details.cause for the curious.
    expect((error as RuntimeError).details).toEqual({ cause: importBoom });
  });

  it("serializes two concurrent transactions instead of colliding on BEGIN", async () => {
    const { db, close } = await openSqlite();

    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

    // A latch the first transaction blocks on AFTER its BEGIN, so the second
    // transaction is dispatched while the first is mid-span. With the FIFO queue
    // the second cannot BEGIN until the first settles; without it the second
    // BEGIN throws "cannot start a transaction within a transaction".
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = db.transaction(async (tx) => {
      await tx.prepare("INSERT INTO t (name) VALUES (?)").run(["first"]);

      await held;
    });

    const second = db.transaction(async (tx) => {
      await tx.prepare("INSERT INTO t (name) VALUES (?)").run(["second"]);
    });

    // Let the event loop turn so the second transaction would BEGIN if it could.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    // Both committed, effects serialized (first then second).
    const rows = await db.prepare("SELECT name FROM t ORDER BY id").all();
    expect(rows).toEqual([{ name: "first" }, { name: "second" }]);

    close();
  });

  it("does not poison the queue when a transaction rolls back", async () => {
    const { db, close } = await openSqlite();

    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

    const boom = new Error("boom");

    const rejected = db.transaction(async (tx) => {
      await tx.prepare("INSERT INTO t (name) VALUES (?)").run(["doomed"]);

      throw boom;
    });

    // Queued immediately behind the rejecting span — it must still run on a clean
    // connection, not inherit a poisoned chain.
    const committed = db.transaction(async (tx) => {
      await tx.prepare("INSERT INTO t (name) VALUES (?)").run(["survivor"]);
    });

    await expect(rejected).rejects.toBe(boom);
    await expect(committed).resolves.toBeUndefined();

    const rows = await db.prepare("SELECT name FROM t").all();
    expect(rows).toEqual([{ name: "survivor" }]);

    close();
  });

  it("runs a nested transaction flat on the same span (inner writes visible after the outer COMMIT)", async () => {
    const { db, close } = await openSqlite();

    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

    const out = await db.transaction(async (tx) => {
      await tx.prepare("INSERT INTO t (name) VALUES (?)").run(["outer"]);

      // Nested call composes flat on the same span — no second BEGIN, no deadlock.
      const inner = await tx.transaction(async (innerTx) => {
        await innerTx.prepare("INSERT INTO t (name) VALUES (?)").run(["inner"]);

        return "inner-ok";
      });

      return inner;
    });

    expect(out).toBe("inner-ok");

    const rows = await db.prepare("SELECT name FROM t ORDER BY id").all();
    expect(rows).toEqual([{ name: "outer" }, { name: "inner" }]);

    close();
  });

  it("rolls back the whole span when a nested transaction throws", async () => {
    const { db, close } = await openSqlite();

    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

    const boom = new Error("inner boom");

    await expect(
      db.transaction(async (tx) => {
        await tx.prepare("INSERT INTO t (name) VALUES (?)").run(["outer"]);

        await tx.transaction(async (innerTx) => {
          await innerTx.prepare("INSERT INTO t (name) VALUES (?)").run(["inner"]);

          throw boom;
        });
      }),
    ).rejects.toBe(boom);

    // The flat inner throw rolled the entire outer span back.
    const rows = await db.prepare("SELECT name FROM t").all();
    expect(rows).toEqual([]);

    close();
  });
});
