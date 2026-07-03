/**
 * The app-owned Postgres bootstrap for the capstone's REAL logical-replication path (ADR 0042
 * Tier-4 v1, Inc8). The v0 SQLite poll needs only `CREATE TABLE` (the engine polls the table); the
 * v1 replication path has THREE additional, non-optional operational preconditions the app must
 * establish itself — this module is where they live, so `serve.ts` (a real deploy) and
 * `test/acceptance.pg.ts` (the gate) run the SAME migration, not a test-private one:
 *
 *   1. **`REPLICA IDENTITY FULL`** on every shape-backing table. A capstone shape filters on the
 *      non-PK `room_id`, so detecting a row that moved OUT of a shape needs the row's OLD image;
 *      under the default replica identity Postgres emits only the primary key, and the
 *      delete-from-shape would silently leak (ADR 0042 acceptance (b)). The shape engine REFUSES
 *      such a shape at registration via the catalog probe, so without this the app would not stream
 *      at all — fail-closed, never fail-open.
 *   2. **A publication** naming EVERY shape-backing table. `pgoutput` streams only the tables in the
 *      publication; a table absent from it yields silence the engine cannot distinguish from "no
 *      changes", so the publication must cover all of {@link capstoneTables} (here, `messages`).
 *   3. (**The replication slot** — created/dropped by the change source itself, `src/app.ts`, not
 *      here: a slot pins WAL until its consumer acks, so its lifecycle belongs to the consumer.)
 *
 * The DDL is idempotent so a real deploy can re-run it on every boot: `CREATE TABLE IF NOT EXISTS`,
 * `REPLICA IDENTITY FULL` (a no-op when already set), and a `DROP … IF EXISTS` + `CREATE PUBLICATION`
 * pair. Table names here come only from {@link capstoneTables} (compile-time constants), never from a
 * request, so the interpolation below has no injection surface.
 */

import { createTableSql } from "@lesto/db";
import type { Table } from "@lesto/db";
import type { KernelDatabase } from "@lesto/kernel";

/** Double-quote a SQL identifier (a table/publication name) — defensive; every name here is a constant. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** What {@link setupPgSchema} needs — the shape-backing tables and the publication to stream them on. */
export interface PgSetupOptions {
  /** Every shape-backing table — each gets `CREATE TABLE`, `REPLICA IDENTITY FULL`, and publication membership. */
  readonly tables: readonly Table[];

  /** The `pgoutput` publication naming the streamed tables (a deployment concern, like the slot). */
  readonly publication: string;
}

/**
 * Establish the replication preconditions on a live Postgres: create each shape-backing table
 * (idempotently, in the Postgres dialect so `boolean`/`timestamp` store as the `INTEGER`→`BIGINT`
 * the replication coercer expects), set it `REPLICA IDENTITY FULL`, and (re)create the publication
 * covering all of them. Run this BEFORE the change source starts (its slot references the publication).
 */
export async function setupPgSchema(
  handle: KernelDatabase,
  options: PgSetupOptions,
): Promise<void> {
  for (const table of options.tables) {
    const createSql = createTableSql(table, "postgres").replace(
      /^CREATE TABLE /,
      "CREATE TABLE IF NOT EXISTS ",
    );

    await handle.exec(createSql);
    await handle.exec(`ALTER TABLE ${quoteIdent(table.tableName)} REPLICA IDENTITY FULL`);
  }

  // Recreate the publication so re-running the bootstrap is idempotent AND picks up any change to
  // the table set (a `CREATE PUBLICATION` alone errors if it already exists).
  await handle.exec(`DROP PUBLICATION IF EXISTS ${options.publication}`);

  const tableList = options.tables.map((table) => quoteIdent(table.tableName)).join(", ");

  await handle.exec(`CREATE PUBLICATION ${options.publication} FOR TABLE ${tableList}`);
}

/**
 * Tear the replication objects down to a clean slate — for the acceptance gate's setup (clearing a
 * prior aborted run) and teardown (leaving no orphaned WAL pin). Drops any named slots (terminating a
 * lingering walsender first), the publication, and the tables. Every step is best-effort: a missing
 * object is not an error, so this is safe to run before the objects exist and after they are gone.
 *
 * The change source drops its OWN slot on `stop()`; this is the belt-and-suspenders cleanup for a slot
 * a crashed prior run left pinning WAL — the disk-fill footgun ADR 0042 makes the deployment own.
 */
export async function cleanPg(
  handle: KernelDatabase,
  options: {
    readonly tables?: readonly Table[];
    readonly publication?: string;
    readonly slots?: readonly string[];
  },
): Promise<void> {
  const swallow = async (sql: string): Promise<void> => {
    try {
      await handle.exec(sql);
    } catch {
      // Best-effort: dropping an object that never existed (or is already gone) is not a failure.
    }
  };

  for (const slot of options.slots ?? []) {
    await swallow(
      `SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name = '${slot}' AND active_pid IS NOT NULL`,
    );
    await swallow(
      `SELECT pg_drop_replication_slot('${slot}') FROM pg_replication_slots WHERE slot_name = '${slot}'`,
    );
  }

  if (options.publication !== undefined) {
    await swallow(`DROP PUBLICATION IF EXISTS ${options.publication}`);
  }

  for (const table of options.tables ?? []) {
    await swallow(`DROP TABLE IF EXISTS ${quoteIdent(table.tableName)} CASCADE`);
  }
}
