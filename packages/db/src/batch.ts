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
 * On a tx handle, `transaction` composes flat, so the same call runs the
 * statements inside the span that is already open.
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

  return db.transaction(async (tx) => {
    const results: BatchResult[] = [];

    // Strictly sequential: a later statement must see the earlier writes.
    for (const statement of statements) {
      results.push(await runOne(tx, statement));
    }

    return results;
  });
}
