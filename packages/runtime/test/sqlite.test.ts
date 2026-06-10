/**
 * `openSqlite` — the framework-owned SQLite driver seam.
 *
 * Two engines, one adapter. The real path boots better-sqlite3 (the engine
 * Node/vitest loads) and exercises the full `exec`/`prepare(run|get|all)`
 * surface, including the `params = []` defaults from both sides. The fallback
 * path injects fake engines: better-sqlite3 "unavailable" (returns `undefined`)
 * so `bun:sqlite` is reached — the branch no Node test could otherwise cover.
 */

import { describe, expect, it, vi } from "vitest";

import { openSqlite } from "../src/sqlite";
import type { SqliteEngines, SqliteHandle } from "../src/sqlite";

describe("openSqlite", () => {
  it("boots the real engine and round-trips through the param adapter", async () => {
    const { db, close } = await openSqlite();

    // exec: DDL with no params.
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

    // run WITH params (the array is spread onto the variadic driver call).
    const insert = db.prepare("INSERT INTO t (name) VALUES (?)");
    const result = insert.run(["ada"]);

    expect(result.changes).toBe(1);
    expect(Number(result.lastInsertRowid)).toBe(1);

    // get WITH params.
    const byId = db.prepare("SELECT name FROM t WHERE id = ?").get([1]);
    expect(byId).toEqual({ name: "ada" });

    // get and all with NO params — covers the `params = []` default branch.
    const count = db.prepare("SELECT COUNT(*) AS n FROM t").get();
    expect(count).toEqual({ n: 1 });

    const all = db.prepare("SELECT name FROM t").all();
    expect(all).toEqual([{ name: "ada" }]);

    close();
  });

  it("falls back to bun:sqlite when better-sqlite3 is unavailable", async () => {
    const closed = vi.fn();

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

    // The adapter wraps the fallback handle just the same.
    expect(db.prepare("SELECT 1").all()).toEqual([]);

    close();
    expect(closed).toHaveBeenCalledOnce();
  });
});
