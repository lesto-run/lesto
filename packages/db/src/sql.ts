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

/**
 * One statement in a {@link SqlDatabase.batch}: SQL with `?` placeholders, its
 * positional params, and what the caller wants back.
 *
 * `returns` is explicit because the engines disagree on how to read a result: a
 * synchronous SQLite engine must pick `all()` (a `SELECT` or a write with
 * `RETURNING`) or `run()` (a plain write) per statement and refuses the wrong one,
 * while D1 and Postgres hand back both. Naming the intent up front keeps every
 * adapter on one contract.
 */
export interface BatchStatement {
  readonly sql: string;

  readonly params: readonly unknown[];

  /** `"rows"` reads the result set; `"changes"` executes for the affected-row count. */
  readonly returns: "rows" | "changes";
}

/** The rows a `returns: "rows"` statement produced, in driver shape (no hydration). */
export interface BatchRowsResult {
  readonly returns: "rows";
  readonly rows: unknown[];
}

/** The affected-row count a `returns: "changes"` statement produced. */
export interface BatchChangesResult {
  readonly returns: "changes";
  readonly changes: number;
}

/** One {@link SqlDatabase.batch} result, tagged with the `returns` its statement asked for. */
export type BatchResult = BatchRowsResult | BatchChangesResult;

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

  /**
   * Run `statements` in order as ONE atomic unit: every statement commits, or
   * none does. Resolves one {@link BatchResult} per statement, in order.
   *
   * This is the portable atomic primitive — the only one Cloudflare D1 has (it
   * has no interactive transaction). A batch is fixed up front: no statement can
   * read an earlier statement's result in JS. A later statement DOES see an
   * earlier statement's writes in SQL, so a check moves into the write. The
   * portable gates work on every dialect: `INSERT … SELECT … WHERE [NOT] EXISTS`,
   * `UPDATE … WHERE state = ?`, a `UNIQUE` index, or a guard statement that fails
   * and rolls the batch back. `changes()` is SQLite/D1-only: Postgres has no such
   * function, so a guard built on it fails on `@lesto/pg` and Hyperdrive.
   *
   * An empty batch is a no-op that resolves `[]` without touching the driver.
   * On a tx handle a batch runs inside a SAVEPOINT of the open transaction, so a
   * failed batch rolls back alone even when the caller catches its error.
   */
  batch(statements: readonly BatchStatement[]): Promise<BatchResult[]>;
}
