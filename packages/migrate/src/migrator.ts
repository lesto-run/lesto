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
  private async ensureTable(): Promise<void> {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (version TEXT PRIMARY KEY)`);
  }

  /** The set of versions already recorded as applied. */
  private async appliedVersions(): Promise<Set<string>> {
    const rows = (await this.db.prepare(`SELECT version FROM ${TABLE}`).all()) as VersionRow[];

    return new Set(rows.map((row) => row.version));
  }

  /**
   * Run every not-yet-applied migration in version order, recording each as it
   * succeeds. Returns the versions actually applied (empty when up to date).
   */
  async migrate(): Promise<string[]> {
    await this.ensureTable();

    const applied = await this.appliedVersions();

    const pending = this.entries.filter((entry) => !applied.has(entry.version));

    // Each migration's DDL and its bookkeeping INSERT are one atomic unit: a
    // half-applied migration (DDL ran, record missing — or vice versa) would
    // corrupt the source of truth. We wrap *each* migration in its own
    // transaction rather than the whole run in one, matching Rails: migrations
    // that succeed earlier in this run stay applied; only the one that throws
    // is rolled back.
    //
    // The transaction is the seam's `transaction()` — NOT raw exec("BEGIN") —
    // so that on a pooled driver every statement in the span (the DDL and the
    // INSERT) runs on the SAME connection. Three separate exec("BEGIN")/
    // exec("COMMIT") calls would land on different pooled connections and
    // silently no-op. We build the Schema and prepare the INSERT against the
    // transaction-scoped `tx`, not the outer db, for exactly this reason. A
    // throw inside `fn` rolls the span back and rejects, undoing the partial
    // DDL and ensuring no record was written.
    for (const entry of pending) {
      await this.db.transaction(async (tx) => {
        const schema = new Schema(tx, this.dialect);

        await entry.migration.up(schema);

        await tx.prepare(`INSERT INTO ${TABLE} (version) VALUES (?)`).run([entry.version]);
      });
    }

    return pending.map((entry) => entry.version);
  }

  /**
   * Reverse the most recently applied migration: run its `down` (if it has one)
   * and delete its record. Returns the version rolled back, or undefined when
   * nothing is applied.
   */
  async rollback(): Promise<string | undefined> {
    await this.ensureTable();

    const applied = await this.appliedVersions();

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
    await this.ensureTable();

    const applied = await this.appliedVersions();

    return this.entries.map((entry) => ({
      version: entry.version,
      applied: applied.has(entry.version),
    }));
  }
}
