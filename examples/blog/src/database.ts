/**
 * The driver seam: adapt a concrete SQLite handle to the kernel's
 * `KernelDatabase` interface.
 *
 * The kernel — and the ORM and migrator beneath it — speak a minimal SQL surface
 * in terms of "an array of positional params". A real driver binds variadically,
 * so this adapter is the one place that maps the array onto its `...spread` call.
 * A Postgres adapter would live here too, identical in shape — the app code above
 * never learns which driver it booted on.
 *
 * The canonical Keel driver is **better-sqlite3** (the same one the kernel's own
 * end-to-end test boots, and the one that runs under Node/vitest). better-sqlite3
 * ships a native addon that Bun cannot yet `dlopen` (oven-sh/bun#4290), so when
 * this demo is run with `bun run` we transparently fall back to Bun's built-in
 * `bun:sqlite`, which presents the same `exec`/`prepare(run|get|all)` surface.
 * Either driver satisfies `KernelDatabase` byte-for-byte; the app is unchanged.
 */

import { createRequire } from "node:module";

import type { KernelDatabase } from "@keel/kernel";

/** The minimal driver shape both SQLite engines expose, once constructed. */
interface SqliteHandle {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

/** Construct better-sqlite3 if its native addon loads, else `undefined`. */
function tryBetterSqlite(filename: string): SqliteHandle | undefined {
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3") as new (file: string) => SqliteHandle;

    return new Database(filename);
  } catch {
    // Native binding unavailable under this runtime (e.g. Bun) — fall back.
    return undefined;
  }
}

/**
 * Construct Bun's built-in `bun:sqlite` handle.
 *
 * The specifier is assembled at runtime so the Node-targeted `tsc` program never
 * tries to resolve `bun:sqlite` (it only exists in the Bun runtime); under Bun
 * the dynamic import resolves the real built-in module.
 */
async function bunSqlite(filename: string): Promise<SqliteHandle> {
  const specifier = ["bun", "sqlite"].join(":");

  const { Database } = (await import(specifier)) as {
    Database: new (file: string) => SqliteHandle;
  };

  return new Database(filename);
}

async function openHandle(filename: string): Promise<SqliteHandle> {
  return tryBetterSqlite(filename) ?? (await bunSqlite(filename));
}

export async function openDatabase(filename = ":memory:"): Promise<{
  db: KernelDatabase;
  close: () => void;
}> {
  const raw = await openHandle(filename);

  const db: KernelDatabase = {
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

  return { db, close: () => raw.close() };
}
