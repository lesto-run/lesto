import { MigrateError } from "./errors";
import { Schema } from "./schema";

import type { SqlDatabase } from "./types";

/** A single, reversible change to the schema. `down` is optional but encouraged. */
export interface Migration {
  up(schema: Schema): void;
  down?(schema: Schema): void;
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
export class Migrator {
  private readonly entries: readonly MigrationEntry[];

  constructor(
    private readonly db: SqlDatabase,
    migrations: MigrationEntry[],
  ) {
    // Sort once, up front, so order is total and independent of caller input.
    // Lexicographic on the version string — the ordering timestamped versions
    // are built for.
    this.entries = migrations.toSorted((a, b) => a.version.localeCompare(b.version));
  }

  /** Create the bookkeeping table if it is not already there. */
  private ensureTable(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (version TEXT PRIMARY KEY)`);
  }

  /** The set of versions already recorded as applied. */
  private appliedVersions(): Set<string> {
    const rows = this.db.prepare(`SELECT version FROM ${TABLE}`).all() as VersionRow[];

    return new Set(rows.map((row) => row.version));
  }

  /**
   * Run every not-yet-applied migration in version order, recording each as it
   * succeeds. Returns the versions actually applied (empty when up to date).
   */
  migrate(): string[] {
    this.ensureTable();

    const applied = this.appliedVersions();

    const pending = this.entries.filter((entry) => !applied.has(entry.version));

    const schema = new Schema(this.db);

    const insert = this.db.prepare(`INSERT INTO ${TABLE} (version) VALUES (?)`);

    // Each migration's DDL and its bookkeeping INSERT are one atomic unit: a
    // half-applied migration (DDL ran, record missing — or vice versa) would
    // corrupt the source of truth. We wrap *each* migration in its own
    // transaction rather than the whole run in one, matching Rails: migrations
    // that succeed earlier in this run stay applied; only the one that throws
    // is rolled back. Both SQLite and Postgres run DDL transactionally, so
    // standard BEGIN/COMMIT/ROLLBACK is enough through the minimal SQL surface.
    for (const entry of pending) {
      this.db.exec("BEGIN");

      try {
        entry.migration.up(schema);

        insert.run([entry.version]);

        this.db.exec("COMMIT");
      } catch (error) {
        // Undo the partial DDL and ensure no record was written. The ROLLBACK
        // is best-effort: if it itself fails we must not mask the original
        // failure, which is the one the caller needs to see.
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Swallow — the original `error` is rethrown below and is what matters.
        }

        throw error;
      }
    }

    return pending.map((entry) => entry.version);
  }

  /**
   * Reverse the most recently applied migration: run its `down` (if it has one)
   * and delete its record. Returns the version rolled back, or undefined when
   * nothing is applied.
   */
  rollback(): string | undefined {
    this.ensureTable();

    const applied = this.appliedVersions();

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

    // A migration without `down` is irreversible in effect, but we still drop the
    // record so the version is no longer considered applied.
    target.migration.down?.(new Schema(this.db));

    this.db.prepare(`DELETE FROM ${TABLE} WHERE version = ?`).run([target.version]);

    return target.version;
  }

  /** Every known version with whether it is currently applied, in order. */
  status(): { version: string; applied: boolean }[] {
    this.ensureTable();

    const applied = this.appliedVersions();

    return this.entries.map((entry) => ({
      version: entry.version,
      applied: applied.has(entry.version),
    }));
  }
}
