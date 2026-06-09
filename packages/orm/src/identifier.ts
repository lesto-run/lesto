import { OrmError } from "./errors";

/**
 * SQL identifier safety.
 *
 * Only VALUES are ever parameterized by a prepared statement; identifiers
 * (table names, column names, ORDER BY keys) are interpolated as text. So a
 * column name sourced from a request — `Post.order(req.query.sort)` — is an
 * injection vector unless we neutralize it here.
 *
 * Two defenses, belt and suspenders:
 *
 *  1. ALLOWLIST. When a model declares its `columns`, any identifier outside
 *     that set is rejected with `ORM_UNKNOWN_COLUMN` before it reaches SQL.
 *
 *  2. QUOTING. Every identifier is wrapped in double quotes with embedded
 *     quotes doubled — the SQL-standard quoting that SQLite and Postgres both
 *     honor. Quoted, an identifier can never break out into arbitrary SQL even
 *     when no allowlist is declared. A literal NUL would terminate the C string
 *     underneath the driver, so it is refused outright.
 */

/** What a Relation/Model can ask about a model's columns, or `undefined` to skip the allowlist. */
export type KnownColumns = readonly string[] | undefined;

// A NUL byte can truncate the identifier inside the native driver — never allow it through.
function assertNoNul(identifier: string): void {
  if (identifier.includes("\0")) {
    throw new OrmError("ORM_UNKNOWN_COLUMN", "SQL identifier may not contain a NUL byte.", {
      identifier,
    });
  }
}

/** Quote an identifier so it can never escape into surrounding SQL. */
export function quoteIdentifier(identifier: string): string {
  assertNoNul(identifier);

  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Quote a column identifier, first rejecting it if the model declares its
 * columns and this one is not among them.
 */
export function quoteColumn(column: string, known: KnownColumns): string {
  if (known !== undefined && !known.includes(column)) {
    throw new OrmError("ORM_UNKNOWN_COLUMN", `Unknown column ${JSON.stringify(column)}.`, {
      column,
      known,
    });
  }

  return quoteIdentifier(column);
}
