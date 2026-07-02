/**
 * Errors carry codes, not just prose.
 *
 * The `live()` builder refuses to mint a shape it cannot key or address — a column that
 * is not on the table, or a table with no primary key to identify rows by — with a stable,
 * machine-readable `code` rather than a silent wrong shape. `createLiveQuery` extends the same
 * discipline to a `def`/store mismatch: a caller-supplied store built from a DIFFERENT shape
 * than the `def` it is paired with would otherwise key/sort/subscribe by one shape while
 * holding rows for another — silently — so it throws loudly instead.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type LiveClientErrorCode =
  /** `where`/`orderBy` referenced a column that is not on the `live(table)` table. */
  | "LIVE_UNKNOWN_COLUMN"
  /** The table has no primary-key column, so `live()` cannot identify its rows. */
  | "LIVE_NO_KEY"
  /**
   * `createLiveQuery(def, { store })` was handed a store whose `shapeId`
   * disagrees with `shapeId(def)` — the store was built from a different `ShapeDefinition` than
   * the `def` passed alongside it.
   */
  | "LIVE_STORE_SHAPE_MISMATCH";

/** Anything the client-side `live()` builder can refuse to build. */
export class LiveClientError extends LestoError<LiveClientErrorCode> {
  constructor(code: LiveClientErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "LiveClientError";
  }
}
