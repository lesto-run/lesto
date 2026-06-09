/**
 * The driver seam for the fixture app — adapt a SQLite handle to KernelDatabase.
 *
 * Under Node, better-sqlite3's native addon loads; under Bun (which cannot yet
 * `dlopen` it) we fall back to the built-in `bun:sqlite`. Both present the same
 * `exec`/`prepare(run|get|all)` surface, so the app is unchanged either way.
 */

import { createRequire } from "node:module";

import type { KernelDatabase } from "@keel/kernel";

interface SqliteHandle {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

function tryBetterSqlite(filename: string): SqliteHandle | undefined {
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3") as new (file: string) => SqliteHandle;

    return new Database(filename);
  } catch {
    return undefined;
  }
}

async function bunSqlite(filename: string): Promise<SqliteHandle> {
  const specifier = ["bun", "sqlite"].join(":");

  const { Database } = (await import(specifier)) as {
    Database: new (file: string) => SqliteHandle;
  };

  return new Database(filename);
}

export async function openDatabase(filename = ":memory:"): Promise<KernelDatabase> {
  const raw = tryBetterSqlite(filename) ?? (await bunSqlite(filename));

  return {
    exec: (sql) => raw.exec(sql),

    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: (params = []) => statement.run(...params),
        get: (params = []) => statement.get(...params),
        all: (params = []) => statement.all(...params),
      };
    },
  };
}
