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
 *   - {@link createLiveDataHttpHandlers} — the app-mounted `GET /__lesto/live-data`
 *     handler that streams a shape's snapshot + change tail over the runtime's
 *     long-lived-stream kind; {@link ShapeConnection} is its tested outbound core.
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

export { ShapeConnection } from "./connection";
export type { FrameController, ShapeConnectionOptions } from "./connection";

export { createLiveDataHttpHandlers, openShapeStream, subscribeSource } from "./http-handlers";
export type {
  LiveDataHttpHandlers,
  LiveDataHttpOptions,
  ShapeStreamConfig,
  ShapeStreamSource,
  StreamTimers,
} from "./http-handlers";
