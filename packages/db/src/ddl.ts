/**
 * Render a {@link Table} value to DDL.
 *
 * The schema is the source of truth for both query types *and* the on-disk
 * shape; this module is the bridge from the value to the `CREATE TABLE` (and
 * `DROP TABLE`) statements a migration runs. A consumer's migration imports
 * the same schema value its queries do, so there is exactly one source for
 * what columns the table has — never a `static columns = [...]` parallel
 * list that drifts.
 */

import type { ColumnSpec } from "./columns";
import { quoteIdentifier } from "./identifier";
import type { Table } from "./table";

/**
 * Which SQL dialect a {@link createTableSql} call should render for.
 *
 * The pitch is "SQLite in dev, Postgres in prod, the same schema value" — so the
 * schema is dialect-free; only the DDL it renders forks here, in exactly two
 * places: how an auto-increment primary key is declared, and how an integer is
 * sized. Everything else (identifiers, defaults, constraints) is identical on
 * both engines. The default is `"sqlite"` so every existing caller is unchanged.
 *
 * This mirrors the `Dialect` seam `@volo/ratelimit` already proves; it is the
 * single source of the dialect vocabulary the queue/cache/workflow installers
 * and the migrator thread through.
 */
export type Dialect = "sqlite" | "postgres";

/** Render a literal default the way SQLite expects it. */
function renderDefault(value: ColumnSpec["defaultValue"]): string {
  // `undefined` is filtered upstream (`modifiers` only calls this when an
  // explicit literal is present), so the only "no value" case here is `null`.
  if (value === null) return "NULL";

  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;

  if (typeof value === "boolean") return value ? "1" : "0";

  return String(value);
}

/**
 * Render the SQL type for a column on the given dialect.
 *
 * `INTEGER` widens to `BIGINT` on Postgres: an epoch-ms timestamp (~1.8e12) and
 * any large counter overflow Postgres's 32-bit `int4`, whereas SQLite's INTEGER
 * is already 64-bit. (`@volo/ratelimit` makes the same call in its hand-written
 * DDL.) `TEXT` / `REAL` are spelled identically on both engines.
 */
function sqlType(spec: ColumnSpec, dialect: Dialect): string {
  if (dialect === "postgres" && spec.sqlType === "INTEGER") return "BIGINT";

  return spec.sqlType;
}

/** Compose the modifier clause for one column, in a stable order. */
function modifiers(spec: ColumnSpec, dialect: Dialect): string {
  const parts: string[] = [];

  if (spec.primaryKey) {
    parts.push("PRIMARY KEY");

    // The one structural fork: SQLite spells an auto-assigned key with the
    // `AUTOINCREMENT` keyword; Postgres has no such keyword and instead declares
    // an identity column (`GENERATED ALWAYS AS IDENTITY`, PG 10+). Both yield a
    // server-assigned surrogate key the consumer never supplies on insert.
    if (spec.autoIncrement) {
      parts.push(dialect === "postgres" ? "GENERATED ALWAYS AS IDENTITY" : "AUTOINCREMENT");
    }
  }

  if (!spec.nullable && !spec.primaryKey) parts.push("NOT NULL");

  // Only render DEFAULT when an explicit literal was set. `hasDefault` is
  // also true for auto-increment primary keys (so InferInsert treats them as
  // optional), but those columns have no literal — they're filled by the engine.
  if (spec.defaultValue !== undefined) parts.push(`DEFAULT ${renderDefault(spec.defaultValue)}`);

  if (spec.unique) parts.push("UNIQUE");

  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/** Render one column's `name TYPE [modifiers]` clause. */
function columnDeclaration(spec: ColumnSpec, dialect: Dialect): string {
  return `${quoteIdentifier(spec.name)} ${sqlType(spec, dialect)}${modifiers(spec, dialect)}`;
}

/**
 * The `CREATE TABLE` statement for a defined table, in the given {@link Dialect}.
 *
 * `dialect` defaults to `"sqlite"`; pass `"postgres"` to render the identity-
 * column / `BIGINT` form an `int4`-strict Postgres requires. The column list,
 * identifiers, and constraints are otherwise byte-identical across dialects.
 */
export function createTableSql(table: Table, dialect: Dialect = "sqlite"): string {
  const cols = table.columnList.map((column) => columnDeclaration(column.spec, dialect)).join(", ");

  return `CREATE TABLE ${quoteIdentifier(table.tableName)} (${cols})`;
}

/** The matching `DROP TABLE` statement. */
export function dropTableSql(table: Table): string {
  return `DROP TABLE ${quoteIdentifier(table.tableName)}`;
}
