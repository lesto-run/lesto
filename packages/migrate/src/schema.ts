import type { ColumnOptions, Dialect, IndexOptions, SqlDatabase } from "./types";

/**
 * The schema editor handed to a migration's `up`/`down`.
 *
 * Tables are defined as a `@lesto/db` schema value and rendered with
 * `schema.execute(createTableSql(table, schema.dialect))` — ONE DDL system,
 * shared with the query layer (ADR 0004 Phase 7.6). `Schema` owns the rest of a
 * migration's vocabulary that the value layer does not: indexes, column adds,
 * drops, and the raw escape hatch — plus the ordering/bookkeeping the migrator
 * provides around them.
 *
 * `dialect` is the engine this migration is running against — exposed (read-only)
 * so a value-DDL migration renders `createTableSql(table, schema.dialect)` for
 * the right engine. It defaults to `"sqlite"`; the migrator passes the real
 * dialect through.
 */
export class Schema {
  constructor(
    private readonly db: SqlDatabase,
    readonly dialect: Dialect = "sqlite",
  ) {}

  async dropTable(name: string): Promise<void> {
    await this.db.exec(`DROP TABLE ${name}`);
  }

  /** Add a single column to an existing table, with the usual modifiers. */
  async addColumn(
    table: string,
    name: string,
    type: string,
    opts: ColumnOptions = {},
  ): Promise<void> {
    const parts: string[] = [];

    if (opts.null === false) parts.push("NOT NULL");

    if (opts.default !== undefined) parts.push(renderDefaultClause(opts.default));

    if (opts.unique === true) parts.push("UNIQUE");

    const modifiers = parts.length === 0 ? "" : ` ${parts.join(" ")}`;

    await this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}${modifiers}`);
  }

  /**
   * Create an index over one or more columns. The name defaults to a stable
   * `idx_<table>_<col1>_<col2>` so repeated runs name the same index.
   */
  async addIndex(
    table: string,
    columns: string | string[],
    opts: IndexOptions = {},
  ): Promise<void> {
    const cols = Array.isArray(columns) ? columns : [columns];

    const name = opts.name ?? `idx_${table}_${cols.join("_")}`;

    const unique = opts.unique === true ? "UNIQUE " : "";

    await this.db.exec(`CREATE ${unique}INDEX ${name} ON ${table} (${cols.join(", ")})`);
  }

  /** Escape hatch: run arbitrary SQL the DSL does not cover. */
  async execute(sql: string): Promise<void> {
    await this.db.exec(sql);
  }
}

/** Render a `DEFAULT <literal>` clause, matching the builder's literal rules. */
function renderDefaultClause(value: string | number | boolean): string {
  if (typeof value === "string") return `DEFAULT '${value.replaceAll("'", "''")}'`;

  if (typeof value === "boolean") return `DEFAULT ${value ? "1" : "0"}`;

  return `DEFAULT ${value}`;
}
