/**
 * A first-party Cloudflare D1 adapter for `@lesto/db`.
 *
 * D1 is Cloudflare's SQLite — the only SQL database a Worker can reach (a Worker
 * has no filesystem, so `openSqlite`/better-sqlite3/`bun:sqlite` are off the table
 * on the edge). `d1ToSqlDatabase` wraps a `D1Database` binding in the same
 * `SqlDatabase` surface `@lesto/db`'s `createDb` consumes, so a DB-driven page runs
 * the IDENTICAL query path on Workers as it does on Node — only the driver differs.
 *
 * A minimal `D1Database` shape is declared here rather than depending on
 * `@cloudflare/workers-types`: only these few methods are used, and keeping the
 * type local means a consumer that hand-types its Worker env (the common case) needs
 * no extra dependency.
 *
 * D1 has no interactive transactions (its only atomic primitive is `batch()`). The
 * `SqlDatabase.transaction(fn)` contract is *interactive* — `fn` reads intermediate
 * results and computes in JS between statements (the rate limiter reads a row, refills
 * it in JS, then writes; the queue reads `RETURNING` ids to wire dependency edges) —
 * which a `batch()` (all statements fixed up front, no JS in between) cannot express.
 *
 * So this adapter does NOT fake a transaction. A no-op passthrough (`fn(adapted)` on
 * the same handle) provides ZERO isolation yet lies that it does: two concurrent
 * isolates read-modify-writing one row lose an update, and a store that trusts the
 * contract (the rate limiter's `must never fail open`) silently fails OPEN. Instead
 * `transaction()` REFUSES with the coded `CLOUDFLARE_D1_TRANSACTION_UNSUPPORTED`, so a
 * caller that needs cross-statement atomicity fails CLOSED (loud, coded) rather than
 * silently corrupting. This mirrors the mature comparator (Drizzle's D1 driver refuses
 * `transaction()` the same way). A writer that wants an atomic multi-statement write
 * uses `SqlDatabase.batch` (`db.batch([...])` through `createDb`), which this adapter
 * maps onto ONE native `d1.batch()` call; a workload that needs a real interactive
 * transaction runs on the Node leg (`openSqlite`/pg), where one is available.
 */

import type { BatchResult, BatchStatement, SqlDatabase } from "@lesto/db";

import { CloudflareError } from "./errors";

/** The slice of D1's prepared-statement API this adapter uses. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;

  run(): Promise<{ meta: { changes?: number; last_row_id?: number } }>;

  first<T = unknown>(): Promise<T | null>;

  all<T = unknown>(): Promise<{ results: T[] }>;
}

/** The slice of one `d1.batch()` result this adapter reads. */
export interface D1BatchResult {
  results: unknown[];

  meta: { changes?: number };
}

/** The slice of the D1 database binding this adapter uses. */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;

  /** Run the statements in order as one atomic transaction (D1's only atomic primitive). */
  batch(statements: D1PreparedStatement[]): Promise<D1BatchResult[]>;
}

/** Map one native batch result onto the `returns` its statement asked for. */
function toBatchResult(statement: BatchStatement, result: D1BatchResult | undefined): BatchResult {
  if (result === undefined) {
    throw new CloudflareError(
      "CLOUDFLARE_D1_BATCH_RESULT_MISSING",
      "d1.batch() returned fewer results than the statements it was given.",
      { sql: statement.sql },
    );
  }

  return statement.returns === "rows"
    ? { returns: "rows", rows: result.results }
    : { returns: "changes", changes: result.meta.changes ?? 0 };
}

/** Adapt a Cloudflare D1 binding to the async `SqlDatabase` surface `@lesto/db` consumes. */
export function d1ToSqlDatabase(d1: D1Database): SqlDatabase {
  const adapted: SqlDatabase = {
    // The driver marker (see `SqlDatabase.dialect`): D1 is Cloudflare's SQLite,
    // so dialect-forking consumers (the queue, `createDb`) infer `"sqlite"`
    // from the handle itself — a queue over D1 must never emit `FOR UPDATE
    // SKIP LOCKED`. (No tx handle to stamp: `transaction()` refuses below.)
    dialect: "sqlite",

    // DDL: a single prepared statement (NOT `d1.exec`, which splits on newlines
    // and would shred a multi-line CREATE TABLE into broken fragments).
    exec: async (sql) => {
      await d1.prepare(sql).run();
    },

    prepare: (sql) => ({
      run: async (params = []) => {
        const { meta } = await d1
          .prepare(sql)
          .bind(...params)
          .run();

        return {
          changes: meta.changes ?? 0,
          ...(meta.last_row_id === undefined ? {} : { lastInsertRowid: meta.last_row_id }),
        };
      },

      get: async (params = []) =>
        (await d1
          .prepare(sql)
          .bind(...params)
          .first()) ?? undefined,

      all: async (params = []) =>
        (
          await d1
            .prepare(sql)
            .bind(...params)
            .all()
        ).results,
    }),

    // D1 has no interactive transaction, and a no-op passthrough would silently
    // strip the atomicity its caller depends on (a read-modify-write would lose
    // updates → a rate limiter fails OPEN). Refuse loudly with a coded rejection
    // so the caller fails CLOSED instead. `fn` is never run — running it on the
    // shared handle is exactly the unsafe behavior this refusal prevents. A
    // rejected promise (not a sync throw) honors the `Promise<T>` contract for
    // every call shape (`await`, `.catch`, or a bare return).
    transaction: () =>
      Promise.reject(
        new CloudflareError(
          "CLOUDFLARE_D1_TRANSACTION_UNSUPPORTED",
          "D1 has no interactive transaction (its only atomic primitive is batch()); " +
            "@lesto/cloudflare refuses transaction() so a caller needing cross-statement " +
            "atomicity fails closed, never silently loses updates. Use batch() for an " +
            "atomic multi-statement write, or run the workload on the Node leg.",
        ),
      ),

    // The native atomic primitive: ONE `d1.batch()` call with every statement
    // bound, in order. D1 rolls the whole batch back when any statement fails. An
    // empty batch never reaches D1, which refuses an empty statement list.
    batch: async (statements) => {
      if (statements.length === 0) return [];

      const results = await d1.batch(
        statements.map((statement) => d1.prepare(statement.sql).bind(...statement.params)),
      );

      return statements.map((statement, index) => toBatchResult(statement, results[index]));
    },
  };

  return adapted;
}
