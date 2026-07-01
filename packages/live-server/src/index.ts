/**
 * @lesto/live-server — the server shape engine for local-first sync (ADR 0042 Tier 4).
 *
 *   - {@link createShapeEngine} — runs registered shapes against the ORM and fans an
 *     initial snapshot + a change tail (insert / update / delete-from-shape) to
 *     subscribers. v0 detects change by a full-table poll ({@link diffRows} the core);
 *     v1 swaps the poll for a Postgres logical-replication tap keyed by commit LSN.
 *   - {@link diffRows} / {@link projectRow} / {@link normalizeWire} — the pure change /
 *     projection / wire-normalization core, decoupled from the poll and the database.
 *
 * The HTTP handler that streams this over the runtime's long-lived-stream kind (the
 * `GET /__lesto/live-data` endpoint) is a separate increment.
 */

export { LiveServerError } from "./errors";
export type { LiveServerErrorCode } from "./errors";

export { diffRows, normalizeWire, projectRow } from "./diff";
export type { DiffResult } from "./diff";

export { createShapeEngine } from "./engine";
export type {
  ShapeChangeListener,
  ShapeEngine,
  ShapeEngineOptions,
  ShapeSubscription,
  TimerSeam,
} from "./engine";
