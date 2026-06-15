import { TableBuilder } from "./table-builder";

import type { ColumnOptions, Dialect, IndexOptions, SqlDatabase } from "./types";

/**
 * The schema editor handed to a migration's `up`/`down`.
 *
 * Every method is a thin, declarative wrapper that renders one DDL statement and
 * sends it straight to the database. The builder owns *what* the SQL looks like;
 * `Schema` owns *that it runs*.
 *
 * `dialect` is the engine this migration is running against — exposed (read-only)
 * so a value-DDL migration can render `createTableSql(table, schema.dialect)`,
 * and threaded into the `TableBuilder` so the DSL's surrogate key matches it.
 * It defaults to `"sqlite"`; the migrator passes the real dialect through.
 */
export class Schema {
  constructor(
    private readonly db: SqlDatabase,
    readonly dialect: Dialect = "sqlite",
  ) {}

  /**
   * Define a table through the builder DSL. The builder seeds an autoincrement
   * `id` (or, on Postgres, an identity column), the callback adds the rest, and
   * we emit a single `CREATE TABLE`.
   */
  async createTable(name: string, build: (t: TableBuilder) => void): Promise<void> {
    const table = new TableBuilder(this.dialect);

    build(table);

    await this.db.exec(`CREATE TABLE ${name} (${table.build()})`);
  }

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
