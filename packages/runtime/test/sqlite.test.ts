/**
 * `openSqlite` — the framework-owned SQLite driver seam (ADR 0006 Wave 1).
 *
 * Two engines, one adapter. The real path boots better-sqlite3 (the engine
 * Node/vitest loads) and exercises the full async `exec`/`prepare(run|get|all)`
 * surface, including the `params = []` defaults from both sides. The fallback
 * path injects async-wrapped sync fakes: better-sqlite3 "unavailable" (returns
 * `undefined`) so `bun:sqlite` is reached — the branch no Node test could
 * otherwise cover without loading `bun:sqlite`. The transaction verb is covered
 * on both its commit and rollback (including failed-rollback) branches.
 */

import { describe, expect, it, vi } from "vitest";

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

    // BEGIN ran; the throwing ROLLBACK was swallowed; COMMIT never ran.
    expect(execed).toEqual(["BEGIN"]);

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
});
