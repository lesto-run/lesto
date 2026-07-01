/**
 * Errors carry codes, not just prose.
 *
 * The `live()` builder refuses to mint a shape it cannot key or address — a column that
 * is not on the table, or a table with no primary key to identify rows by — with a stable,
 * machine-readable `code` rather than a silent wrong shape.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type LiveClientErrorCode =
  /** `where`/`orderBy` referenced a column that is not on the `live(table)` table. */
  | "LIVE_UNKNOWN_COLUMN"
  /** The table has no primary-key column, so `live()` cannot identify its rows. */
  | "LIVE_NO_KEY";

/** Anything the client-side `live()` builder can refuse to build. */
export class LiveClientError extends LestoError<LiveClientErrorCode> {
  constructor(code: LiveClientErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "LiveClientError";
  }
}
