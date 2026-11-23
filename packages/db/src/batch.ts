/**
 * `batch` for every driver that HAS an interactive transaction.
 *
 * SQLite (sync engines and the OPFS worker) and Postgres (a pool, or one Hyperdrive
 * connection) can already pin a `BEGIN`…`COMMIT` span to one connection through
 * {@link SqlDatabase.transaction}. A batch on those drivers is that span with its
 * statements run in order — so every such adapter shares this one copy instead of
 * re-spelling the loop. Only D1, which has no interactive transaction, maps
 * `batch` to its native primitive instead.
 *
 * On a tx handle a batch runs inside a SAVEPOINT instead ({@link batchViaSavepoint}),
 * so a failed batch rolls back alone and the open transaction stays usable.
 */

import type { BatchResult, BatchStatement, SqlDatabase } from "./sql";

/** Run one statement on `handle` and tag its result with the `returns` it asked for. */
async function runOne(
  handle: Pick<SqlDatabase, "prepare">,
  statement: BatchStatement,
): Promise<BatchResult> {
  const prepared = handle.prepare(statement.sql);
  const params = [...statement.params];

  if (statement.returns === "rows") {
    return { returns: "rows", rows: await prepared.all(params) };
  }

  const { changes } = await prepared.run(params);

  return { returns: "changes", changes };
}

/** Run `statements` in order on `handle`, one result per statement. */
async function runInOrder(
  handle: Pick<SqlDatabase, "prepare">,
  statements: readonly BatchStatement[],
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];

  // Strictly sequential: a later statement must see the earlier writes.
  for (const statement of statements) {
    results.push(await runOne(handle, statement));
  }

  return results;
}

/**
 * Run `statements` in order inside ONE `transaction` on `db`. A throwing
 * statement rejects the span, so the driver rolls back every earlier write and
 * the caller receives the original error. An empty list resolves `[]` and never
 * opens a transaction.
 */
export async function batchViaTransaction(
  db: Pick<SqlDatabase, "transaction">,
  statements: readonly BatchStatement[],
): Promise<BatchResult[]> {
  if (statements.length === 0) return [];

  return db.transaction((tx) => runInOrder(tx, statements));
}

/** Distinct savepoint names, so two batches on one tx handle never release each other's. */
let savepoints = 0;

/**
 * Run `statements` in order inside a SAVEPOINT on an already-open transaction
 * (`tx`). A throwing statement rolls back to the savepoint, so the batch leaves
 * no write behind even when the caller catches the error and the outer
 * transaction commits. Both SQLite and Postgres support `SAVEPOINT`. An empty
 * list resolves `[]` and sends nothing.
 */
export async function batchViaSavepoint(
  tx: Pick<SqlDatabase, "exec" | "prepare">,
  statements: readonly BatchStatement[],
): Promise<BatchResult[]> {
  if (statements.length === 0) return [];

  savepoints += 1;
  const name = `lesto_batch_${savepoints}`;

  await tx.exec(`SAVEPOINT ${name}`);

  try {
    const results = await runInOrder(tx, statements);

    await tx.exec(`RELEASE SAVEPOINT ${name}`);

    return results;
  } catch (error) {
    try {
      await tx.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      await tx.exec(`RELEASE SAVEPOINT ${name}`);
    } catch {
      // Best-effort: a failed rollback must not mask the original error.
    }

    throw error;
  }
}
