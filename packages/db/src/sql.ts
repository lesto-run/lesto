/**
 * The minimal SQL surface — what `@lesto/db` consumes from a driver.
 *
 * Identical in shape to the surface `@lesto/migrate` declares (and re-declared by
 * the other async consumers — cache, queue, workflows, the kernel):
 * `prepare(sql)` returning a statement with `run` / `get` / `all`, plus
 * `exec(sql)` for migrations and other multi-statement DDL. A single adapter
 * (better-sqlite3 / `bun:sqlite` via `@lesto/runtime`'s `openSqlite`, or a future
 * Postgres pool via `@lesto/pg`) satisfies the whole surface, so the kernel hands
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

import type { Dialect } from "./ddl";

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
  /**
   * Which SQL dialect this handle speaks — the driver's own stamp.
   *
   * OPTIONAL, and stamped by every blessed adapter that mints a `SqlDatabase`
   * (`adaptSyncSqlite` — and through it `@lesto/runtime`'s `openSqlite` and
   * `@lesto/live`'s OPFS driver — plus `@lesto/pg`'s pool adapter and
   * `@lesto/cloudflare`'s D1/Hyperdrive adapters), INCLUDING on the tx handle
   * their `transaction()` hands out (a tx handle is a `SqlDatabase` too).
   *
   * Consumers whose SQL forks on the engine (the queue's `FOR UPDATE SKIP
   * LOCKED` claim, `createDb`'s offset rendering) read it to INFER the dialect
   * when the caller passed none — so a Postgres app that forgets the flag gets
   * Postgres semantics, not a silent downgrade — and to CROSS-CHECK an explicit
   * option against it, refusing a contradiction with a coded error rather than
   * rendering the wrong engine's SQL. Absent on foreign (hand-rolled) handles,
   * which keep each consumer's historical `"sqlite"` default.
   */
  readonly dialect?: Dialect;

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
