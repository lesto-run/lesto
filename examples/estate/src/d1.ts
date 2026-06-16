/**
 * A Cloudflare D1 adapter for `@keel/db`.
 *
 * D1 is Cloudflare's SQLite — the only SQL database a Worker can reach (a Worker
 * has no filesystem, so `openSqlite`/better-sqlite3/`bun:sqlite` are off the
 * table on the edge). This wraps a `D1Database` binding in the same
 * `SqlDatabase` surface `createDb` consumes, so the DB-driven content page runs
 * the IDENTICAL query path on the edge as it does on Node — only the driver
 * differs.
 *
 * A minimal `D1Database` shape is declared locally rather than pulling in
 * `@cloudflare/workers-types`: estate already types its Worker bindings by hand
 * (see `worker.ts`), and only these few methods are used.
 *
 * D1 has no interactive transactions (its atomic primitive is `batch()`), so
 * `transaction` degrades to running `fn` directly — sound here because the
 * content store only ever reads and one-shot seeds, neither of which needs
 * rollback. A future writer that needs atomicity would use `d1.batch` directly.
 */

import type { SqlDatabase } from "@keel/db";

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

/** Adapt a Cloudflare D1 binding to the async `SqlDatabase` surface `@keel/db` consumes. */
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

    // D1 has no interactive transaction; the content store needs none (read +
    // one-shot seed). Run the body directly on the same handle.
    transaction: async (fn) => fn(adapted),
  };

  return adapted;
}
