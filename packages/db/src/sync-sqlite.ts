/**
 * The shared sync-SQLite FIFO transaction adapter (ADR 0042 Inc5/Inc6 hardening).
 *
 * Both `@lesto/runtime`'s `openSqlite` (better-sqlite3 / `bun:sqlite`, Node/Bun) and
 * `@lesto/live`'s OPFS-SQLite driver (`@sqlite.org/sqlite-wasm`, the browser) wrap ONE
 * synchronous, single-connection SQLite engine into the async {@link SqlDatabase} seam. The
 * `exec`/`prepare` half of that seam is engine-specific (a native addon's `.exec`/`.prepare` vs.
 * an oo1 handle's `{sql, bind}` options form) and stays with each caller; the `transaction`
 * half — the manual `BEGIN`…`COMMIT`/`ROLLBACK` span, FIFO-serialized over the one connection —
 * was pasted into both. This is that one tested copy: hand it the engine-specific
 * `exec`/`prepare` pair and it returns the full {@link SqlDatabase}.
 *
 * ## FIFO serialization
 *
 * A synchronous engine has exactly one connection, so two overlapping `transaction()` calls
 * must never both be "open" at once — the second `BEGIN` would throw ("cannot start a
 * transaction within a transaction") the instant an async callback's `await` lets the two
 * interleave. Every span therefore runs through one {@link createFifoQueue} (one queue per
 * returned database) and only starts once every earlier item has fully settled.
 *
 * Statements on the ROOT handle (`db.exec`, `db.prepare(sql).run/get/all`) go through the same
 * queue. Without that, a solo write issued while another caller's span is open lands inside
 * that span: the span's rollback erases a write that already resolved, and a `changes()` guard
 * in a batch reads the solo statement's count. Statements on a TX handle run directly, because
 * they belong to the span that holds the queue. So inside a `transaction` callback, use `tx`:
 * a root-handle statement there waits for the span it is part of, and never runs.
 *
 * ## A rejected span does not poison the queue
 *
 * The queue's internal link swallows a settled item's rejection ONLY to gate the next item, so
 * a rolled-back transaction never wedges every later one. The CALLER still receives a promise
 * that rejects with the ORIGINAL error untouched.
 *
 * ## Rollback is best-effort
 *
 * A failed `fn` triggers a `ROLLBACK`. If THAT also throws (a torn connection, an
 * already-closed handle), the rollback's failure is swallowed so the ORIGINAL error from `fn`
 * is what the caller sees — a cleanup failure must never mask the failure it was cleaning up
 * after.
 *
 * ## Nested transactions compose flat
 *
 * SQLite has no nested `BEGIN` on one connection, so `tx.transaction(inner)` does NOT
 * re-enqueue onto the queue — doing so would deadlock, since the outer span already holds the
 * queue slot the inner call would then wait on. Instead the tx-scoped handle's `transaction`
 * runs `inner` directly against itself, so a nested call composes flat onto the same span —
 * the same shape `@lesto/pg`'s adapter uses for a driver with no nested-transaction primitive.
 */

import { batchViaSavepoint, batchViaTransaction } from "./batch";
import { createFifoQueue } from "./fifo";
import type { SqlDatabase, SqlStatement } from "./sql";

/**
 * Wrap engine-specific statements (`exec`/`prepare` over ONE synchronous in-process SQLite
 * connection) into a full {@link SqlDatabase} whose `transaction` runs a FIFO-serialized manual
 * `BEGIN`…`COMMIT`/`ROLLBACK` span — the shape `@lesto/runtime`'s `openSqlite` and the OPFS
 * driver both need. See the module doc for the FIFO/rollback/flat-nesting invariants this
 * closes over.
 *
 * `statements.exec` is expected to `await` a call into the synchronous engine (e.g.
 * `async (sql) => raw.exec(sql)`) — there is no real I/O latency, so awaiting it is equivalent
 * to the engine's synchronous call, and this function never touches the engine directly.
 */
export function adaptSyncSqlite(statements: Pick<SqlDatabase, "exec" | "prepare">): SqlDatabase {
  // One queue for the one connection. Every span (transaction or batch) AND every statement on
  // the root handle goes through it, so a root statement can never land inside another caller's
  // open BEGIN…COMMIT — where a rollback would erase it, or a `changes()` guard would read it.
  // Statements on a tx handle run directly: they belong to the span that holds the queue.
  const queue = createFifoQueue();

  const queuedPrepare = (sql: string): SqlStatement => {
    const statement = statements.prepare(sql);

    return {
      run: (params) => queue.run(() => statement.run(params)),
      get: (params) => queue.run(() => statement.get(params)),
      all: (params) => queue.run(() => statement.all(params)),
    };
  };

  const db: SqlDatabase = {
    exec: (sql) => queue.run(() => statements.exec(sql)),

    prepare: queuedPrepare,

    // The driver marker (see `SqlDatabase.dialect`): this adapter only ever
    // wraps a synchronous SQLite engine, so every handle it mints — including
    // the tx handle below — speaks sqlite. Consumers (the queue, `createDb`)
    // infer the dialect from this stamp instead of trusting a caller-remembered
    // flag, and both `openSqlite` and the OPFS driver inherit it from here.
    dialect: "sqlite",

    // Single-connection FIFO transaction: the span waits for every earlier queued item to
    // settle before `BEGIN`, so spans never overlap on the one connection. A rolled-back span
    // does not poison the queue (see `createFifoQueue`); the caller still receives the
    // original error.
    transaction: <T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> =>
      queue.run(async () => {
        await statements.exec("BEGIN");

        try {
          // The tx-scoped handle shares the one connection's `exec`/`prepare`. A nested
          // `transaction` runs `inner` FLAT on this same span — SQLite has no nested BEGIN, so
          // composing flat (rather than re-enqueuing, which would deadlock against the queue
          // this span already holds) matches the shape a real Postgres adapter uses. A batch
          // on it runs inside a SAVEPOINT, so a failed batch rolls back alone.
          const tx: SqlDatabase = {
            ...statements,
            dialect: "sqlite",
            transaction: (inner) => inner(tx),
            batch: (batched) => batchViaSavepoint(tx, batched),
          };

          const out = await fn(tx);

          await statements.exec("COMMIT");

          return out;
        } catch (error) {
          try {
            await statements.exec("ROLLBACK");
          } catch {
            // Best-effort: a failed rollback must not mask the original error.
          }

          throw error;
        }
      }),

    // A batch is one FIFO-serialized transaction span with its statements run in
    // order, so it queues behind (and never interleaves with) any other span.
    batch: (batched) => batchViaTransaction(db, batched),
  };

  return db;
}
