/**
 * Errors carry codes, not just prose.
 *
 * The shape engine refuses a shape it cannot safely serve — a table it does not know,
 * a column that is not on that table, or a key column that is not provably unique — with
 * a stable, machine-readable `code`, rather than compiling a query over an unvalidated
 * client-named identifier.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type LiveServerErrorCode =
  /** The shape names a table the engine was not given in its registry. */
  | "LIVE_SERVER_UNKNOWN_TABLE"
  /** The shape projects/filters/orders a column that does not exist on its table. */
  | "LIVE_SERVER_UNKNOWN_COLUMN"
  /** The shape's key column is not a primary key or unique column — it cannot identify rows. */
  | "LIVE_SERVER_NON_UNIQUE_KEY";

/** Anything the shape engine can refuse to register or serve. */
export class LiveServerError extends LestoError<LiveServerErrorCode> {
  constructor(code: LiveServerErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "LiveServerError";
  }
}
