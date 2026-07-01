/**
 * @lesto/live-protocol — the pure, runtime-agnostic contract for local-first sync
 * (ADR 0042 Tier 4). Both the browser store (`@lesto/live`) and the server shape engine
 * bind to it, so neither depends on the other's runtime.
 *
 *   - {@link ShapeDefinition} — the serializable shape (table, key, columns, structured
 *     `where`, total order); {@link shapeId} its stable subscribe/cache key.
 *   - {@link matchesShape} / {@link compareRows} / {@link rowKey} — the pure predicate,
 *     total-order, and identity semantics the engine and store share.
 *   - {@link validateShapeDefinition} / {@link serializeShapeDefinition} /
 *     {@link parseShapeDefinition} — the subscribe-request trust boundary.
 *   - the SSE **row-data** frame codec ({@link snapshotFrame} / {@link changeFrame} /
 *     {@link resyncFrame} / {@link commentFrame} and their decoders).
 *
 * Unlike `@lesto/realtime`, this wire carries auth-scoped ROW DATA, never a topic (the
 * deliberate ADR 0042 vs ADR 0027/0040 split).
 */

export { LiveProtocolError } from "./errors";
export type { LiveProtocolErrorCode } from "./errors";

export {
  compareRows,
  matchesShape,
  parseShapeDefinition,
  rowKey,
  serializeShapeDefinition,
  shapeId,
  validateShapeDefinition,
} from "./shape";
export type {
  Direction,
  Filter,
  FilterOp,
  FilterValue,
  OrderBy,
  Row,
  RowKey,
  ShapeChange,
  ShapeDefinition,
} from "./shape";

export {
  changeFrame,
  commentFrame,
  decodeChangeData,
  decodeSnapshotData,
  isValidCursor,
  resyncFrame,
  snapshotFrame,
} from "./frames";
export type { Cursor, SnapshotPayload } from "./frames";
