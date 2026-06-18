/**
 * The vocabulary of the migrator.
 *
 * Like every Volo module, this one depends on a *minimal SQL surface* — not on
 * any one driver. better-sqlite3 satisfies it structurally today; a Postgres
 * driver will satisfy the same shape tomorrow, and the migrator never knows the
 * difference.
 */

/**
 * Which SQL dialect a migration renders DDL for. Defaults to `"sqlite"`.
 *
 * The migrator threads this to every `Schema` it builds, so the auto-increment
 * surrogate key the builder seeds (`AUTOINCREMENT` on SQLite, identity column on
 * Postgres) — and any `@volo/db` `createTableSql(table, schema.dialect)` a
 * value-DDL migration renders — match the engine the migration is running
 * against. Mirrors `@volo/db`'s `Dialect`.
 */
export type Dialect = "sqlite" | "postgres";

// ---- the minimal SQL surface (driver-agnostic) ----

export interface SqlStatement {
  run(params?: unknown[]): Promise<{ changes: number }>;
  all(params?: unknown[]): Promise<unknown[]>;
}

export interface SqlDatabase {
  /** Run one or more statements for side effect. The result is never read. */
  exec(sql: string): Promise<void>;

  /**
   * Compile a statement. STAYS SYNCHRONOUS — only the terminal verbs touch the
   * wire (ADR 0006). The Postgres adapter makes this lazy; SQLite prepares once.
   */
  prepare(sql: string): SqlStatement;

  /**
   * Run `fn` inside a single, atomic transaction, pinned to one connection.
   *
   * The seam owns this rather than leaving callers to issue raw
   * `exec("BEGIN")`/`exec("COMMIT")` — on a pooled driver those three calls land
   * on *different* connections and silently no-op. `transaction` resolves to
   * `fn`'s result on commit, or rejects (after rolling back) if `fn` throws.
   */
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;
}

// ---- column options for the schema builder ----

/** Modifiers that apply to any column the builder emits. */
export interface ColumnOptions {
  /** When `false`, the column is `NOT NULL`. Omitted/`true` leaves it nullable. */
  readonly null?: boolean;

  /** When `true`, the column carries a `UNIQUE` constraint. */
  readonly unique?: boolean;

  /** A literal default, rendered as a SQL literal by type. */
  readonly default?: string | number | boolean;
}

/** Options for a standalone index. */
export interface IndexOptions {
  /** When `true`, the index is `UNIQUE`. */
  readonly unique?: boolean;

  /** Override the auto-generated `idx_<table>_<columns>` index name. */
  readonly name?: string;
}
