/**
 * The vocabulary of the migrator.
 *
 * Like every Keel module, this one depends on a *minimal SQL surface* — not on
 * any one driver. better-sqlite3 satisfies it structurally today; a Postgres
 * driver will satisfy the same shape tomorrow, and the migrator never knows the
 * difference.
 */

// ---- the minimal SQL surface (driver-agnostic) ----

export interface SqlStatement {
  run(params?: unknown[]): { changes: number };
  all(params?: unknown[]): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
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

/** A reference column may also pin a real foreign-key constraint. */
export interface ReferenceOptions extends ColumnOptions {
  /** When `true`, also emit `FOREIGN KEY(<name>_id) REFERENCES <name>s(id)`. */
  readonly foreignKey?: boolean;
}

/** Options for a standalone index. */
export interface IndexOptions {
  /** When `true`, the index is `UNIQUE`. */
  readonly unique?: boolean;

  /** Override the auto-generated `idx_<table>_<columns>` index name. */
  readonly name?: string;
}
