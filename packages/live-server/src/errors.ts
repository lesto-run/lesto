/**
 * Errors carry codes, not just prose.
 *
 * The shape engine refuses a shape it cannot safely serve — a table it does not know,
 * a column that is not on that table, or a key column that is not provably unique — with
 * a stable, machine-readable `code`, rather than compiling a query over an unvalidated
 * client-named identifier. The logical-replication change source adds lifecycle-guard
 * codes for its own misuse (starting twice, or starting after the terminal slot-dropping
 * stop) so a caller branches on the code, never a message string.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type LiveServerErrorCode =
  /** The shape names a table the engine was not given in its registry. */
  | "LIVE_SERVER_UNKNOWN_TABLE"
  /** The shape projects/filters/orders a column that does not exist on its table. */
  | "LIVE_SERVER_UNKNOWN_COLUMN"
  /** The shape's key column is not a primary key or unique column — it cannot identify rows. */
  | "LIVE_SERVER_NON_UNIQUE_KEY"
  /**
   * `start()` was called on a replication source that is already running. Re-starting
   * would re-issue `CREATE_REPLICATION_SLOT` (which errors on an existing slot) and orphan
   * the first connection — a coded misuse, not a driver failure.
   */
  | "LIVE_SERVER_REPLICATION_ALREADY_STARTED"
  /**
   * `start()` was called on a replication source that has already been stopped. Stop is
   * terminal: it DROPS the slot (releasing pinned WAL), so the source cannot be resumed —
   * a fresh source (and a fresh snapshot) is required.
   */
  | "LIVE_SERVER_REPLICATION_STOPPED";

/** Anything the shape engine can refuse to register or serve. */
export class LiveServerError extends LestoError<LiveServerErrorCode> {
  constructor(code: LiveServerErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "LiveServerError";
  }
}
