import type { ColumnOptions, Dialect, ReferenceOptions } from "./types";

/**
 * Render a literal default the way SQLite expects it.
 *
 * Strings are quoted (with embedded quotes doubled, the SQL escape); booleans
 * collapse to 1/0, SQLite's integer truth values; numbers pass through.
 */
function renderDefault(value: string | number | boolean): string {
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;

  if (typeof value === "boolean") return value ? "1" : "0";

  return String(value);
}

/**
 * Assemble the modifier clause shared by every column.
 *
 * Order is fixed so output is stable and diffable: NOT NULL, then DEFAULT, then
 * UNIQUE. `null: false` is the only way to get NOT NULL; columns are nullable by
 * default, matching SQLite.
 */
function modifiers(opts: ColumnOptions): string {
  const parts: string[] = [];

  if (opts.null === false) parts.push("NOT NULL");

  if (opts.default !== undefined) parts.push(`DEFAULT ${renderDefault(opts.default)}`);

  if (opts.unique === true) parts.push("UNIQUE");

  // A leading space keeps the column free to be `name TYPE` with no trailing gap
  // when there are no modifiers at all.
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/**
 * Accumulates a table definition one column at a time, then renders the
 * `CREATE TABLE` body. Every table is born with a surrogate primary key, so the
 * caller never has to remember to add `id`.
 */
export class TableBuilder {
  /** Column definitions, in declaration order, after the implicit `id`. */
  private readonly columns: string[] = [];

  /** Table-level constraints (foreign keys), appended after the columns. */
  private readonly constraints: string[] = [];

  /** The integer width FK columns adopt, matching the surrogate key they point at. */
  private readonly intType: string;

  constructor(dialect: Dialect = "sqlite") {
    this.intType = dialect === "postgres" ? "BIGINT" : "INTEGER";
    // The surrogate key is the one column whose spelling forks per dialect:
    // SQLite uses the `AUTOINCREMENT` keyword; Postgres has none and declares an
    // identity column (and a 64-bit `BIGINT` so the key cannot overflow int4).
    this.columns.push(
      dialect === "postgres"
        ? "id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY"
        : "id INTEGER PRIMARY KEY AUTOINCREMENT",
    );
  }

  private column(name: string, type: string, opts: ColumnOptions): void {
    this.columns.push(`${name} ${type}${modifiers(opts)}`);
  }

  string(name: string, opts: ColumnOptions = {}): void {
    this.column(name, "TEXT", opts);
  }

  text(name: string, opts: ColumnOptions = {}): void {
    this.column(name, "TEXT", opts);
  }

  integer(name: string, opts: ColumnOptions = {}): void {
    this.column(name, this.intType, opts);
  }

  boolean(name: string, opts: ColumnOptions = {}): void {
    this.column(name, this.intType, opts);
  }

  float(name: string, opts: ColumnOptions = {}): void {
    this.column(name, "REAL", opts);
  }

  datetime(name: string, opts: ColumnOptions = {}): void {
    this.column(name, "TEXT", opts);
  }

  /**
   * Add a `<name>_id` integer pointing at another table. A real FOREIGN KEY
   * constraint is only emitted when the caller opts in — references are cheap,
   * enforced constraints are a deliberate choice.
   */
  references(name: string, opts: ReferenceOptions = {}): void {
    this.column(`${name}_id`, this.intType, opts);

    if (opts.foreignKey === true) {
      this.constraints.push(`FOREIGN KEY(${name}_id) REFERENCES ${name}s(id)`);
    }
  }

  /** The conventional pair of timestamp columns every record carries. */
  timestamps(): void {
    this.columns.push("created_at TEXT");
    this.columns.push("updated_at TEXT");
  }

  /** Render the comma-separated body of the `CREATE TABLE (...)` statement. */
  build(): string {
    return [...this.columns, ...this.constraints].join(", ");
  }
}
