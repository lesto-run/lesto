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
  | "LIVE_SERVER_REPLICATION_STOPPED"
  /**
   * The `pgoutput` stream delivered a change for a relation whose `Relation` message was never
   * seen — a protocol violation (pgoutput always announces a relation before its first change),
   * so the change cannot be decoded (no column names) rather than guessed.
   */
  | "LIVE_SERVER_REPLICATION_UNKNOWN_RELATION"
  /**
   * `stop()` could not drop the replication slot within its bounded retry — the walsender did not
   * release it in time, so the slot (and its pinned WAL) is left in place. Surfaced, never
   * swallowed: a silently-undropped slot is the disk-fill outage this module exists to prevent, so
   * the deployment's slot-lag alerting + disk-pressure runbook must act on it.
   */
  | "LIVE_SERVER_REPLICATION_SLOT_DROP_TIMEOUT"
  /**
   * A shape filters a **non-key** column, but its table is not `REPLICA IDENTITY FULL`, so the
   * replication stream cannot supply the old row image needed to classify a row that leaves the
   * shape — serving it would silently fail to emit delete-from-shape and leak the row into the
   * client's durable store. Refused at registration (fix: `ALTER TABLE … REPLICA IDENTITY FULL`).
   */
  | "LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT"
  /**
   * A shape's table is in the JS table allowlist but does **not exist in the live database**, so the
   * replica-identity catalog probe cannot resolve it. Distinct from `LIVE_SERVER_UNKNOWN_TABLE` (the
   * shape named a table the engine's registry never had): here the registry has it, but Postgres does
   * not. Wraps the driver's raw `relation "…" does not exist` (SQLSTATE `42P01`) so `subscribe`'s
   * error contract stays coded, not a leaked driver error (fix: create the table / correct the name).
   */
  | "LIVE_SERVER_TABLE_NOT_IN_DATABASE"
  /**
   * A replication `update`/`delete` did not carry a **full** old row image (its old-tuple marker was
   * key-only or absent) for a shape whose predicate reads a non-key column — the runtime counterpart
   * to the registration-time `LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT` guard. Even a shape that
   * passed that guard can be undermined if its table is `ALTER`ed `FULL`→`DEFAULT` *after*
   * registration: Postgres then emits a key-only old tuple (non-identity columns nulled), evaluating
   * the predicate on it would misclassify a delete-from-shape, and the row would silently persist in
   * the client's store. Keyed on the decoder's old-tuple marker (not the image's cell values, which
   * cannot tell a key-tuple null from a genuine one), detected per change and thrown loudly (routed
   * to the engine's error sink) rather than dropped in silence — fix by restoring
   * `REPLICA IDENTITY FULL` on the table.
   */
  | "LIVE_SERVER_OLD_IMAGE_INCOMPLETE"
  /**
   * A replication update changed a row's **key** column. A shape keys its client store by the key,
   * and a v1 shape assumes an immutable primary key, so a key change would strand the row under its
   * old key (a stale duplicate) rather than move it. Refused loudly rather than silently stranding;
   * multi-frame key migration (delete-old + insert-new) is out of scope for v1.
   */
  | "LIVE_SERVER_PRIMARY_KEY_CHANGED";

/** Anything the shape engine can refuse to register or serve. */
export class LiveServerError extends LestoError<LiveServerErrorCode> {
  constructor(code: LiveServerErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "LiveServerError";
  }
}
