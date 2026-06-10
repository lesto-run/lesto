/**
 * SQL identifier safety.
 *
 * Only VALUES are ever parameterized through prepared statements; identifiers
 * (table names, column names) are interpolated as text. Quoting them — and
 * refusing a NUL byte that would truncate the identifier inside the native
 * driver — is the structural defense.
 *
 * Identifiers reaching this layer come from the schema-as-value (the
 * `defineTable` call sites), not from request input, so injection risk is
 * already low. The quoting is belt-and-suspenders against a footgun where a
 * caller forwards a runtime string into a column reference path.
 */

import { DbError } from "./errors";

/** Quote an identifier with SQL-standard double quotes, doubling embedded quotes. */
export function quoteIdentifier(identifier: string): string {
  if (identifier.includes("\0")) {
    throw new DbError("DB_NO_TABLE", "SQL identifier may not contain a NUL byte.", {
      identifier,
    });
  }

  return `"${identifier.replaceAll('"', '""')}"`;
}
