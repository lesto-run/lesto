/**
 * The minimal SQL surface — what `@keel/db` consumes from a driver.
 *
 * Identical in shape to the surfaces `@keel/orm` and `@keel/migrate` declare:
 * `prepare(sql)` returning a statement with `run` / `get` / `all`, plus
 * `exec(sql)` for migrations and other multi-statement DDL. A single
 * better-sqlite3 adapter satisfies the whole surface, so the kernel can hand
 * the same handle to every layer and the layers never know the driver.
 *
 * Parameters are *positional* (an array), to keep the contract scalar across
 * SQLite (which binds variadically) and a future Postgres driver (which binds
 * `$1`, `$2`). Drivers adapt one shape to the other; the layer above sees
 * `params: unknown[]`.
 */

export interface SqlStatement {
  run(params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(params?: unknown[]): unknown;
  all(params?: unknown[]): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
}
