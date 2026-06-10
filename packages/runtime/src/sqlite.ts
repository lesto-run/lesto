/**
 * Open a local SQLite database as a `KernelDatabase` — the one driver seam,
 * owned by the framework instead of pasted into every app.
 *
 * The kernel, migrator, and `@keel/db` query layer all speak a minimal SQL
 * surface in terms of "an array of positional params". A real SQLite driver
 * binds variadically, so this adapter is the single place that maps the array
 * onto a `...spread` call. Before this lived here it was copy-pasted into every
 * example, the CLI fixture, and the scaffolder's generated `keel.app.ts`; now a
 * consumer writes `const { db } = await openSqlite()` and is done.
 *
 * The canonical driver is **better-sqlite3** (the one the kernel's own
 * end-to-end test boots under Node/vitest). better-sqlite3 ships a native addon
 * Bun cannot yet `dlopen` (oven-sh/bun#4290), so under Bun we transparently fall
 * back to the built-in `bun:sqlite`, which presents the same
 * `exec`/`prepare(run|get|all)` surface. Either engine satisfies
 * `KernelDatabase` byte-for-byte; app code never learns which one it booted on.
 *
 * The two concrete engine loaders are injectable ({@link SqliteEngines}) so the
 * fallback path is testable with fakes — a native `require` and a Bun-only
 * dynamic import can never both run under one test runtime. The real loaders are
 * the untestable wiring in `./sqlite-drivers` (excluded from coverage, like
 * `bin.ts`); everything decided here is covered.
 */

import { realSqliteEngines } from "./sqlite-drivers";

/**
 * The async database seam the kernel boots on (ADR 0006 Wave 1).
 *
 * The I/O terminal verbs — `exec` and a prepared statement's `run`/`get`/`all` —
 * return Promises so a future network-bound driver (Postgres) satisfies the same
 * shape. `prepare()` STAYS SYNCHRONOUS: compiling SQL to a statement handle is a
 * pure value operation, not a round-trip. `transaction` is first-class so the
 * seam — not each caller — owns BEGIN/COMMIT/ROLLBACK.
 *
 * Under SQLite a "transaction" is the degenerate single-connection case: the
 * one handle runs the bracketing statements and `fn` runs against the same `db`.
 */
export interface AsyncKernelDatabase {
  exec(sql: string): Promise<unknown>;

  prepare(sql: string): {
    run(params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
    get(params?: unknown[]): Promise<unknown>;
    all(params?: unknown[]): Promise<unknown[]>;
  };

  /**
   * Run `fn` inside a transaction: `BEGIN`, then `fn(db)`, then `COMMIT` on
   * success or `ROLLBACK` on throw (the rollback itself is best-effort). The
   * resolved value of `fn` is returned; a thrown error propagates after rollback.
   */
  transaction<T>(fn: (tx: AsyncKernelDatabase) => Promise<T>): Promise<T>;
}

/** The minimal driver shape both SQLite engines expose, once constructed. */
export interface SqliteHandle {
  exec(sql: string): unknown;

  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };

  close(): void;
}

/**
 * The two engine loaders, injected so {@link openSqlite}'s fallback is testable.
 *
 * `betterSqlite` returns a handle, or `undefined` when its native addon cannot
 * load (the signal to fall back). `bunSqlite` loads Bun's built-in engine.
 */
export interface SqliteEngines {
  betterSqlite(filename: string): SqliteHandle | undefined;
  bunSqlite(filename: string): Promise<SqliteHandle>;
}

/** A booted SQLite handle plus the call that releases its connection. */
export interface OpenSqlite {
  db: AsyncKernelDatabase;
  close: () => void;
}

/**
 * Open a SQLite database at `filename` (default in-memory) and adapt it to the
 * `KernelDatabase` the kernel boots on. Prefers better-sqlite3 and falls back to
 * `bun:sqlite` when its native addon is unavailable. Returns the handle plus a
 * `close` that releases the underlying connection.
 */
export async function openSqlite(
  filename = ":memory:",
  engines: SqliteEngines = realSqliteEngines,
): Promise<OpenSqlite> {
  const raw = engines.betterSqlite(filename) ?? (await engines.bunSqlite(filename));

  const db: AsyncKernelDatabase = {
    // I/O terminal verbs are async: a SQLite engine returns synchronously, so we
    // `await` a resolved value (zero latency) to present the Postgres-shaped seam.
    exec: async (sql) => raw.exec(sql),

    // `prepare` stays synchronous — compiling SQL is a pure value operation — but
    // the statement's terminal verbs are async for the same reason as `exec`.
    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: async (params = []) => statement.run(...params),
        get: async (params = []) => statement.get(...params),
        all: async (params = []) => statement.all(...params),
      };
    },

    // Single-connection (SQLite) transaction: the same handle brackets `fn` with
    // BEGIN/COMMIT, rolling back (best-effort) on any throw before re-raising.
    transaction: async (fn) => {
      raw.exec("BEGIN");

      try {
        const out = await fn(db);

        raw.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          // Best-effort: a failed rollback must not mask the original error.
        }

        throw error;
      }
    },
  };

  return { db, close: () => raw.close() };
}
