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

/** Render a literal default the way SQLite expects it. */
function renderDefault(value: ColumnSpec["defaultValue"]): string {
  // `undefined` is filtered upstream (`modifiers` only calls this when an
  // explicit literal is present), so the only "no value" case here is `null`.
  if (value === null) return "NULL";

  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;

  if (typeof value === "boolean") return value ? "1" : "0";

  return String(value);
}

/** Compose the modifier clause for one column, in a stable order. */
function modifiers(spec: ColumnSpec): string {
  const parts: string[] = [];

  if (spec.primaryKey) {
    parts.push("PRIMARY KEY");

    if (spec.autoIncrement) parts.push("AUTOINCREMENT");
  }

  if (!spec.nullable && !spec.primaryKey) parts.push("NOT NULL");

  // Only render DEFAULT when an explicit literal was set. `hasDefault` is
  // also true for auto-increment primary keys (so InferInsert treats them as
  // optional), but those columns have no literal — they're filled by SQLite.
  if (spec.defaultValue !== undefined) parts.push(`DEFAULT ${renderDefault(spec.defaultValue)}`);

  if (spec.unique) parts.push("UNIQUE");

  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/** Render one column's `name TYPE [modifiers]` clause. */
function columnDeclaration(spec: ColumnSpec): string {
  return `${quoteIdentifier(spec.name)} ${spec.sqlType}${modifiers(spec)}`;
}

/** The `CREATE TABLE` statement for a defined table. */
export function createTableSql(table: Table): string {
  const cols = table.columnList.map((column) => columnDeclaration(column.spec)).join(", ");

  return `CREATE TABLE ${quoteIdentifier(table.tableName)} (${cols})`;
}

/** The matching `DROP TABLE` statement. */
export function dropTableSql(table: Table): string {
  return `DROP TABLE ${quoteIdentifier(table.tableName)}`;
}
