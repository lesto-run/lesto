/**
 * The minimal SQL surface — what `@keel/db` consumes from a driver.
 *
 * Identical in shape to the surfaces `@keel/migrate` (and the legacy `@keel/orm`)
 * declare: `prepare(sql)` returning a statement with `run` / `get` / `all`, plus
 * `exec(sql)` for migrations and other multi-statement DDL. A single adapter
 * (better-sqlite3 / `bun:sqlite` via `@keel/runtime`'s `openSqlite`, or a future
 * Postgres pool via `@keel/pg`) satisfies the whole surface, so the kernel hands
 * the same handle to every layer and the layers never know the driver.
 *
 * The terminals are **asynchronous** (ADR 0006): `run` / `get` / `all` and `exec`
 * return Promises so a networked Postgres pool — which speaks over a socket — can
 * back the same surface as in-process SQLite. `prepare(sql)` stays *synchronous*:
 * it only compiles a statement object; binding + execution is what awaits. There
 * is no sync escape hatch — a sync-over-async shim would re-introduce the
 * event-loop blocking this design exists to remove.
 *
 * Parameters are *positional* (an array), to keep the contract scalar across
 * SQLite (which binds variadically) and Postgres (which binds `$1`, `$2`).
 * Drivers adapt one shape to the other; the layer above sees `params: unknown[]`.
 */

export interface SqlStatement {
  /**
   * Execute a write. `lastInsertRowid` is **optional**: SQLite supplies it
   * natively, but Postgres has no implicit row id (use `RETURNING id`), so a
   * driver may omit it.
   */
  run(params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  get(params?: unknown[]): Promise<unknown>;
  all(params?: unknown[]): Promise<unknown[]>;
}

export interface SqlDatabase {
  exec(sql: string): Promise<void>;

  prepare(sql: string): SqlStatement;

  /**
   * Run `fn` inside a single transaction on a single connection. Commits when
   * `fn` resolves, rolls back when it rejects (re-raising the original error).
   *
   * First-class because correctness depends on it: on a pooled driver, separate
   * `exec("BEGIN")` / `exec("COMMIT")` calls would land on *different* pooled
   * connections and the transaction would silently wrap nothing. `transaction`
   * pins one connection for the whole span.
   */
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;
}
