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
 * interleave. Every call therefore enqueues its whole `BEGIN…COMMIT/ROLLBACK` span onto a
 * shared `chain` promise (closed over per {@link adaptSyncSqlite} call — one chain per
 * returned database) and only starts once the previous span has fully settled.
 *
 * ## A rejected span does not poison the queue
 *
 * The sequencing link — `chain = run.then(() => undefined, () => undefined)` — exists ONLY to
 * gate the *next* `BEGIN`: it swallows the previous span's rejection so a rolled-back
 * transaction never wedges every later one. The CALLER still receives `run` itself, which
 * rejects with the ORIGINAL error untouched. Two separate promises carry two separate
 * concerns — `chain` answers "has the connection freed up?"; `run` answers "what happened to
 * my span?" — and conflating them (e.g. gating on the swallowing promise) would silently drop
 * every transaction's error.
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
 * re-enqueue onto `chain` — doing so would deadlock, since the outer span already holds the
 * queue slot the inner call would then wait on. Instead the tx-scoped handle's `transaction`
 * runs `inner` directly against itself, so a nested call composes flat onto the same span —
 * the same shape `@lesto/pg`'s adapter uses for a driver with no nested-transaction primitive.
 */

import type { SqlDatabase } from "./sql";

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
  // The FIFO chain: every transaction enqueues its BEGIN…COMMIT/ROLLBACK span onto this promise
  // so the next one cannot `BEGIN` until the previous span has fully settled. Without it, two
  // concurrent `transaction()` calls on the single shared connection interleave at the
  // `await fn(...)` microtask boundary and the second `BEGIN` throws ("cannot start a
  // transaction within a transaction").
  let chain: Promise<unknown> = Promise.resolve();

  const db: SqlDatabase = {
    ...statements,

    // Single-connection FIFO transaction. Each call appends its span to `chain` and waits for
    // the previous span to settle before `BEGIN`, so spans never overlap on the one connection.
    // A rolled-back (rejected) span must not poison the queue: the sequencing link swallows the
    // previous link's rejection (`.then(() => undefined, () => undefined)`) purely to gate the
    // next BEGIN, while the caller still receives a promise that rejects with the original error.
    transaction: async <T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> => {
      const run = chain.then(async () => {
        await statements.exec("BEGIN");

        try {
          // The tx-scoped handle shares the one connection's `exec`/`prepare`. A nested
          // `transaction` runs `inner` FLAT on this same span — SQLite has no nested BEGIN, so
          // composing flat (rather than re-enqueuing, which would deadlock against the chain
          // this span already holds) matches the shape a real Postgres adapter uses.
          const tx: SqlDatabase = { ...statements, transaction: (inner) => inner(tx) };

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
      });

      // Gate the next span on this one settling, but never let its rejection poison the
      // chain — sequencing only cares that the span ENDED.
      chain = run.then(
        () => undefined,
        () => undefined,
      );

      return run;
    },
  };

  return db;
}
