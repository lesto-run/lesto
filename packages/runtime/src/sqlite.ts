/**
 * Open a local SQLite database as a `KernelDatabase` — the one driver seam,
 * owned by the framework instead of pasted into every app.
 *
 * The kernel, migrator, and `@lesto/db` query layer all speak a minimal SQL
 * surface in terms of "an array of positional params". A real SQLite driver
 * binds variadically, so this adapter is the single place that maps the array
 * onto a `...spread` call. Before this lived here it was copy-pasted into every
 * example, the CLI fixture, and the scaffolder's generated `lesto.app.ts`; now a
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
 *
 * Transactions are serialized FIFO over the one shared connection: each
 * `transaction()` enqueues onto an internal promise chain and only `BEGIN`s once
 * the previous span has fully settled, so concurrent transactions (steady-state
 * once the rate-limit store runs one per request) never collide on the second
 * `BEGIN`. Nested transactions compose flat — an inner `tx.transaction(...)` runs
 * its callback on the same span rather than re-enqueuing (which would deadlock).
 * Cross-*process* SQLite writers remain out of scope: SQLite is the single-node
 * dev default; fleets run Postgres.
 */

import type { KernelDatabase } from "@lesto/kernel";

import { realSqliteEngines } from "./sqlite-drivers";

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
  db: KernelDatabase;
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

  // The shared `exec`/`prepare` half of the seam over the one connection. Both
  // the top-level db and a tx-scoped handle reuse these closures — there is only
  // ever one connection, so they always hit the same engine handle.
  const statements: Pick<KernelDatabase, "exec" | "prepare"> = {
    // I/O terminal verbs are async: a SQLite engine returns synchronously, so we
    // `await` a resolved value (zero latency) to present the Postgres-shaped seam.
    exec: async (sql) => {
      raw.exec(sql);
    },

    // `prepare` stays synchronous — compiling SQL is a pure value operation — but
    // the statement's terminal verbs are async for the same reason as `exec`.
    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: async (params = []) => statement.run(...params),
        // A miss is `undefined`, never the driver's `null`: the SQL stores
        // (sessions, rate limits, cache) cast `.get()` to `… | undefined` and
        // guard on `undefined`, and the pg adapter already normalizes the same
        // way (`rows[0] ?? undefined`). Honor that one contract on both drivers.
        get: async (params = []) => statement.get(...params) ?? undefined,
        all: async (params = []) => statement.all(...params),
      };
    },
  };

  // The FIFO chain: every transaction enqueues its BEGIN…COMMIT/ROLLBACK span
  // onto this promise so the next one cannot `BEGIN` until the previous span has
  // fully settled. Without it, two concurrent `transaction()` calls on the single
  // shared connection interleave at the `await fn(...)` microtask boundary and
  // the second `BEGIN` throws "cannot start a transaction within a transaction".
  let chain: Promise<unknown> = Promise.resolve();

  const db: KernelDatabase = {
    ...statements,

    // Single-connection (SQLite) FIFO transaction. Each call appends its span to
    // `chain` and waits for the previous span to settle before `BEGIN`, so spans
    // never overlap on the one connection. A rolled-back (rejected) span must not
    // poison the queue: the sequencing link swallows the previous link's rejection
    // (`.then(noop, noop)`) purely to gate the next BEGIN, while the caller still
    // receives a promise that rejects with the original error.
    transaction: async <T>(fn: (tx: KernelDatabase) => Promise<T>): Promise<T> => {
      const run = chain.then(async () => {
        raw.exec("BEGIN");

        try {
          // The tx-scoped handle shares the one connection's `exec`/`prepare`.
          // A nested `transaction` runs `inner` FLAT on this same span — SQLite
          // has no nested BEGIN, so composing flat (rather than re-enqueuing,
          // which would deadlock against the chain this span already holds)
          // matches the shape `createPgDatabase` uses (pg adapter.ts:107–110).
          const tx: KernelDatabase = {
            ...statements,
            transaction: (inner) => inner(tx),
          };

          const out = await fn(tx);

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
      });

      // Gate the next span on this one settling, but never let its rejection
      // poison the chain — sequencing only cares that the span ENDED.
      chain = run.then(
        () => undefined,
        () => undefined,
      );

      return run;
    },
  };

  return { db, close: () => raw.close() };
}
