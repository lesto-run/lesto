/**
 * The two concrete SQLite engine loaders — the irreducible runtime wiring.
 *
 * Excluded from coverage like `bin.ts`: a native-addon `require` and a Bun-only
 * dynamic `import` can never both run under one test runtime (Node/vitest loads
 * better-sqlite3 and never reaches the `bun:sqlite` path; under Bun the reverse
 * holds), so the *decisions* that consume these — the fallback and the param
 * adapter — live in the covered `sqlite.ts`, tested with fake engines.
 */

import { createRequire } from "node:module";

import type { SqliteEngines, SqliteHandle } from "./sqlite";

/** Construct better-sqlite3 if its native addon loads, else `undefined`. */
function requireBetterSqlite(filename: string): SqliteHandle | undefined {
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
 * The specifier is assembled at runtime so a Node-targeted `tsc` never tries to
 * resolve `bun:sqlite` (it exists only in the Bun runtime); under Bun the
 * dynamic import resolves the real built-in module.
 */
async function importBunSqlite(filename: string): Promise<SqliteHandle> {
  const specifier = ["bun", "sqlite"].join(":");

  const { Database } = (await import(specifier)) as {
    Database: new (file: string) => SqliteHandle;
  };

  return new Database(filename);
}

/** The production engine pair: better-sqlite3 first, `bun:sqlite` as fallback. */
export const realSqliteEngines: SqliteEngines = {
  betterSqlite: requireBetterSqlite,
  bunSqlite: importBunSqlite,
};
