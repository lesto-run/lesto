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
  | "DB_INVALID_BOUND"
  | "DB_UNRESOLVED_REFERENCE"
  | "DB_DUPLICATE_JOIN_NAMESPACE"
  /**
   * `createDb` was given an explicit `dialect` that contradicts the dialect the
   * driver handle itself is stamped with (`SqlDatabase.dialect`). One of the two
   * is wrong, and rendering the wrong engine's SQL corrupts quietly — so the
   * contradiction is refused loudly here instead of silently picking a side.
   */
  | "DB_DIALECT_MISMATCH"
  /**
   * A driver's `batch()` returned fewer results than statements, or a result
   * tagged for the wrong `returns` — an adapter bug, refused rather than decoded
   * into a wrong value.
   */
  | "DB_BATCH_RESULT_MISMATCH"
  /**
   * A root-handle statement was issued from inside the handle's own open span
   * (transaction or batch callback) on a single-connection adapter. It would wait
   * for that span forever, so it is refused; use the `tx` handle instead.
   */
  | "DB_ROOT_STATEMENT_IN_SPAN";

/** Anything the query/DDL layer can refuse to do. */
export class DbError extends LestoError<DbErrorCode> {
  constructor(code: DbErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "DbError";
  }
}
