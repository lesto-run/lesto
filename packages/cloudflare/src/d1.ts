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
 * reaches for `d1.batch` directly; a workload that needs a real interactive transaction
 * runs on the Node leg (`openSqlite`/pg), where one is available.
 */

import type { SqlDatabase } from "@lesto/db";

import { CloudflareError } from "./errors";

/** The slice of D1's prepared-statement API this adapter uses. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;

  run(): Promise<{ meta: { changes?: number; last_row_id?: number } }>;

  first<T = unknown>(): Promise<T | null>;

  all<T = unknown>(): Promise<{ results: T[] }>;
}

/** The slice of the D1 database binding this adapter uses. */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

/** Adapt a Cloudflare D1 binding to the async `SqlDatabase` surface `@lesto/db` consumes. */
export function d1ToSqlDatabase(d1: D1Database): SqlDatabase {
  const adapted: SqlDatabase = {
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
            "atomicity fails closed, never silently loses updates. Use d1.batch for an " +
            "atomic multi-statement write, or run the workload on the Node leg.",
        ),
      ),
  };

  return adapted;
}
