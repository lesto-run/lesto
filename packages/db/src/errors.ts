/**
 * Errors carry codes, not just prose.
 *
 * Every failure in the data layer surfaces a stable, machine-readable `code`.
 * Logs, tests, API responses, and the MCP surface branch on the code — never
 * on a message string, which is free to change for humans without breaking
 * machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type DbErrorCode =
  | "DB_NO_TABLE"
  | "DB_NO_CONDITIONS"
  | "DB_EMPTY_INSERT"
  | "DB_EMPTY_UPDATE"
  | "DB_INVALID_LIMIT"
  | "DB_UNRESOLVED_REFERENCE"
  | "DB_DUPLICATE_JOIN_NAMESPACE";

/** Anything the query/DDL layer can refuse to do. */
export class DbError extends LestoError<DbErrorCode> {
  constructor(code: DbErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "DbError";
  }
}
