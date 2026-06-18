/**
 * A first-party Cloudflare D1 adapter for `@volo/db`.
 *
 * D1 is Cloudflare's SQLite — the only SQL database a Worker can reach (a Worker
 * has no filesystem, so `openSqlite`/better-sqlite3/`bun:sqlite` are off the table
 * on the edge). `d1ToSqlDatabase` wraps a `D1Database` binding in the same
 * `SqlDatabase` surface `@volo/db`'s `createDb` consumes, so a DB-driven page runs
 * the IDENTICAL query path on Workers as it does on Node — only the driver differs.
 *
 * A minimal `D1Database` shape is declared here rather than depending on
 * `@cloudflare/workers-types`: only these few methods are used, and keeping the
 * type local means a consumer that hand-types its Worker env (the common case) needs
 * no extra dependency.
 *
 * D1 has no interactive transactions (its atomic primitive is `batch()`), so
 * `transaction` degrades to running `fn` directly on the same handle — sound for the
 * read + one-shot-seed workloads `@volo/db` drives on the edge. A writer that needs
 * cross-statement atomicity should reach for `d1.batch` directly.
 */

import type { SqlDatabase } from "@volo/db";

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

/** Adapt a Cloudflare D1 binding to the async `SqlDatabase` surface `@volo/db` consumes. */
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

    // D1 has no interactive transaction; the edge workloads need none (read +
    // one-shot seed). Run the body directly on the same handle.
    transaction: async (fn) => fn(adapted),
  };

  return adapted;
}
