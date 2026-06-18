import { MigrateError } from "./errors";
import { Schema } from "./schema";

import type { Dialect, SqlDatabase } from "./types";

/** A single, reversible change to the schema. `down` is optional but encouraged. */
export interface Migration {
  up(schema: Schema): void | Promise<void>;
  down?(schema: Schema): void | Promise<void>;
}

/** A migration paired with the version string that orders and records it. */
export interface MigrationEntry {
  readonly version: string;
  readonly migration: Migration;
}

/** One row of the bookkeeping table: which versions we have applied. */
interface VersionRow {
  readonly version: string;
}

const TABLE = "schema_migrations";

/**
 * The fixed Postgres advisory-lock key for "the Lesto migration lock". Any value
 * works as long as every migrator uses the SAME one; this is an arbitrary,
 * stable bigint chosen to be unlikely to collide with an application's own
 * advisory locks. Sent as a bound parameter, never interpolated.
 */
const LOCK_KEY = 4_705_321_001;

/**
 * Applies and reverses migrations, recording each in `schema_migrations`.
 *
 * The recorded set is the source of truth: a migration runs exactly when its
 * version is absent from the table, so `migrate()` is idempotent and safe to run
 * on every boot. Versions are applied in lexicographic order — the same scheme
 * Tracks (and Rails) use for timestamped version strings.
 */
export interface MigratorOptions {
  /**
   * The SQL dialect every migration in this run renders DDL for. Defaults to
   * `"sqlite"`. Each `Schema` the migrator builds carries it, so the builder's
   * surrogate key and any `createTableSql(table, schema.dialect)` match the
   * engine behind `db`.
   */
  readonly dialect?: Dialect;
}

export class Migrator {
  private readonly entries: readonly MigrationEntry[];

  private readonly dialect: Dialect;

  constructor(
    private readonly db: SqlDatabase,
    migrations: MigrationEntry[],
    options: MigratorOptions = {},
  ) {
    // Sort once, up front, so order is total and independent of caller input.
    // Lexicographic on the version string — the ordering timestamped versions
    // are built for.
    this.entries = migrations.toSorted((a, b) => a.version.localeCompare(b.version));
    this.dialect = options.dialect ?? "sqlite";
  }

  /** Create the bookkeeping table if it is not already there. */
  private async ensureTable(db: SqlDatabase): Promise<void> {
    await db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (version TEXT PRIMARY KEY)`);
  }

  /** The set of versions already recorded as applied. */
  private async appliedVersions(db: SqlDatabase): Promise<Set<string>> {
    const rows = (await db.prepare(`SELECT version FROM ${TABLE}`).all()) as VersionRow[];

    return new Set(rows.map((row) => row.version));
  }

  /**
   * Run `fn` while holding the cross-process migration lock, so two booting
   * instances of a fleet never run migrations against the same database at once.
   * `fn` receives the db handle it MUST run every statement against.
   *
   * On Postgres this is a TRANSACTION-level advisory lock
   * (`pg_advisory_xact_lock`) on a fixed key, taken as the first statement of a
   * single `transaction()` span that wraps the entire run: a second migrator's
   * `pg_advisory_xact_lock` BLOCKS until the first's transaction ends — one runs,
   * one waits, zero DDL collisions.
   *
   * Two properties make `_xact_` the right primitive here, where a session lock
   * (`pg_advisory_lock` / `pg_advisory_unlock`) is subtly wrong:
   *
   *   - It releases EXACTLY at COMMIT/ROLLBACK, atomically. A session lock
   *     unlocked in a `finally` would release just BEFORE the surrounding
   *     transaction commits, so the waiting migrator would acquire it, read the
   *     not-yet-committed `schema_migrations`, find the version absent, and
   *     re-run the DDL — a "relation already exists" collision. The xact lock is
   *     held until the writer's data is durable, so the waiter only ever sees a
   *     committed (already-applied) state.
   *   - It needs no `finally` to unlock: a throwing migration rolls the span back
   *     and the lock is dropped with it. Nothing can strand it.
   *
   * CRITICAL: `fn` is handed the PINNED `tx`, not `this.db`. The whole migrate
   * body must run inside this one locked transaction. If `migrate()` instead
   * opened fresh `this.db.transaction(...)` spans, a pool with `max: 1` would
   * have its only connection already held by this span — the inner `connect()`
   * would wait forever for a connection that never frees (a self-deadlock).
   * Because both the `@lesto/pg` adapter and `openSqlite` run a NESTED
   * `transaction` FLAT on the same handle, threading `tx` through makes each
   * per-migration span run on this connection: no second checkout, no deadlock,
   * and (via the xact lock) the whole run is one atomic, serialized unit.
   *
   * On SQLite there is no cross-process concern the engine does not already
   * solve: the runtime serializes every write over its single connection (a
   * file lock under the hood), so concurrent migrators queue FIFO. The default
   * therefore just runs `fn(this.db)` directly — the seam exists so the PG path
   * can override it without the SQLite path paying for a lock it does not need.
   */
  private async withMigrationLock<T>(fn: (db: SqlDatabase) => Promise<T>): Promise<T> {
    if (this.dialect !== "postgres") {
      return fn(this.db);
    }

    // `LOCK_KEY` is a fixed bigint identifying "the Lesto migration lock". The
    // transaction-level lock is held for the whole span and released atomically
    // at COMMIT, so the waiting migrator never observes a half-applied state.
    return this.db.transaction(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(?)").run([LOCK_KEY]);

      return fn(tx);
    });
  }

  /**
   * Run every not-yet-applied migration in version order, recording each as it
   * succeeds. Returns the versions actually applied (empty when up to date).
   *
   * The whole run — ensure-table, read-applied, apply-pending — is wrapped in the
   * cross-process {@link withMigrationLock}, so a fleet booting N instances at
   * once still runs each migration exactly once.
   */
  async migrate(): Promise<string[]> {
    // `db` is the handle the lock hands us: the PINNED advisory-lock connection on
    // Postgres, `this.db` on SQLite. Every statement below runs on it — see
    // {@link withMigrationLock} for why running on `this.db` instead would
    // self-deadlock a `max: 1` Postgres pool.
    return this.withMigrationLock(async (db) => {
      await this.ensureTable(db);

      const applied = await this.appliedVersions(db);

      const pending = this.entries.filter((entry) => !applied.has(entry.version));

      // Each migration's DDL and its bookkeeping INSERT are one atomic unit (a
      // half-applied migration — DDL ran, record missing, or vice versa — would
      // corrupt the source of truth), so each runs in a `transaction()` span via
      // the seam's `transaction()`, never a raw exec("BEGIN") that a pooled driver
      // would scatter across connections.
      //
      // The rollback GRANULARITY differs by dialect — load-bearing, not incidental:
      //   - SQLite: `db` is the top-level handle (no outer lock span), so each
      //     iteration is its OWN independent BEGIN/COMMIT. A failure in the Nth
      //     migration rolls back only the Nth; earlier ones already committed and
      //     stay applied (Rails-style).
      //   - Postgres: `db` is the PINNED advisory-lock connection and the pg
      //     adapter runs a nested `transaction` FLAT (`inner => inner(tx)`), so
      //     every iteration joins the ONE outer transaction the xact lock holds.
      //     The whole run is therefore atomic: a failure rolls back EVERY migration
      //     in this run, not just the failing one. That is the price of a
      //     transaction-level lock held across the run (see `withMigrationLock`) —
      //     and the safer prod default: `schema_migrations` is all-or-nothing, and
      //     a fixed migration re-runs the set cleanly on the next boot.
      // Either way, `schema_migrations` never records a migration whose DDL rolled
      // back. We build the Schema + prepare the INSERT against the span's `tx`.
      for (const entry of pending) {
        await db.transaction(async (tx) => {
          const schema = new Schema(tx, this.dialect);

          await entry.migration.up(schema);

          await tx.prepare(`INSERT INTO ${TABLE} (version) VALUES (?)`).run([entry.version]);
        });
      }

      return pending.map((entry) => entry.version);
    });
  }

  /**
   * Reverse the most recently applied migration: run its `down` (if it has one)
   * and delete its record. Returns the version rolled back, or undefined when
   * nothing is applied.
   */
  async rollback(): Promise<string | undefined> {
    await this.ensureTable(this.db);

    const applied = await this.appliedVersions(this.db);

    if (applied.size === 0) return undefined;

    // The DB is the source of truth for *what* is applied, so the latest applied
    // version comes from the recorded set — not from `this.entries`, which may be
    // missing a migration whose file was deleted. Lexicographically-greatest is
    // the most recently applied, matching the order migrations are applied in.
    const latestVersion = [...applied].toSorted((a, b) => a.localeCompare(b)).at(-1)!;

    const target = this.entries.find((entry) => entry.version === latestVersion);

    // The most-recently-applied migration has no definition we can load. Rolling
    // back anything else would reverse the *wrong* migration and corrupt state,
    // so we refuse rather than silently pick an older entry.
    if (target === undefined) {
      throw new MigrateError(
        "MIGRATE_MISSING_MIGRATION",
        `Cannot roll back: the most recently applied migration "${latestVersion}" has no loaded definition. Restore its migration file before rolling back.`,
        { version: latestVersion, applied: [...applied] },
      );
    }

    // Symmetric with migrate(): the `down` DDL and the bookkeeping DELETE are one
    // atomic span on one connection, via the seam's transaction() — a raw
    // multi-statement sequence would land on different pooled connections under a
    // pooled (Postgres) driver and silently no-op. A throw inside `down` rolls the
    // whole reversal back, so the version stays recorded as applied rather than
    // half-reverted. A migration without `down` is irreversible in effect, but we
    // still drop the record so the version is no longer considered applied.
    await this.db.transaction(async (tx) => {
      await target.migration.down?.(new Schema(tx, this.dialect));

      await tx.prepare(`DELETE FROM ${TABLE} WHERE version = ?`).run([target.version]);
    });

    return target.version;
  }

  /** Every known version with whether it is currently applied, in order. */
  async status(): Promise<{ version: string; applied: boolean }[]> {
    await this.ensureTable(this.db);

    const applied = await this.appliedVersions(this.db);

    return this.entries.map((entry) => ({
      version: entry.version,
      applied: applied.has(entry.version),
    }));
  }
}
