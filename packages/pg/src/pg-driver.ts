/**
 * The real node-postgres pool — the irreducible engine wiring.
 *
 * Excluded from coverage (like `@lesto/runtime`'s `sqlite-drivers.ts`): it needs
 * `pg` installed and, to exercise meaningfully, a live Postgres. The adapter's
 * decisions — translation, the SqlDatabase mapping, pooled transactions — live
 * in the covered `adapter.ts`, tested against a fake pool.
 *
 * `pg` is NOT a dependency of this package: it is loaded dynamically and typed
 * structurally as a {@link PgPool}, so the consumer provides `pg` (mirroring how
 * apps provide `better-sqlite3` for `openSqlite`).
 */

import { createRequire } from "node:module";

import type { PgConfig, PgPool } from "./adapter";

/** Construct a real `pg.Pool`, adapted to the structural {@link PgPool} shape. */
export function realPool(config: PgConfig): PgPool {
  const require = createRequire(import.meta.url);

  const { Pool } = require("pg") as { Pool: new (config: PgConfig) => PgPool };

  return new Pool(config);
}
