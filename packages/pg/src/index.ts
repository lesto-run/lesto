/**
 * @volo/pg — the Postgres driver for Volo's async data layer (ADR 0006).
 *
 *   import { openPostgres } from "@volo/pg";
 *   import { createApp } from "@volo/kernel";
 *
 *   const { db, close } = await openPostgres({ connectionString: process.env.DATABASE_URL });
 *   const app = await createApp({ db, router, controllers, migrations });
 *
 * Adapts a node-postgres `Pool` to the same `SqlDatabase` seam in-process SQLite
 * satisfies (`@volo/runtime`'s `openSqlite`) — so an app moves from SQLite to a
 * networked Postgres pool with no change above the driver. Provide `pg` yourself
 * (it is loaded dynamically, like `better-sqlite3` for `openSqlite`).
 */

import type { SqlDatabase } from "@volo/db";

import { openPostgres as openPostgresWith } from "./adapter";
import type { PgConfig } from "./adapter";
import { realPool } from "./pg-driver";

export { createPgDatabase } from "./adapter";
export type { PgConfig, PgPool, PgClient, PgQueryable, PgQueryResult } from "./adapter";

/** Open a Postgres-backed `SqlDatabase` over a real `pg.Pool` (drain with `close`). */
export function openPostgres(
  config: PgConfig,
): Promise<{ db: SqlDatabase; close: () => Promise<void> }> {
  return openPostgresWith(config, realPool);
}
