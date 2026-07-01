/**
 * The Server-Sent Events wire codec for local-first sync (ADR 0042) — the pure string
 * layer between the shape's row model and the bytes an `EventSource` reads.
 *
 * Unlike `@lesto/realtime`'s codec, this wire carries **auth-scoped row data**, not an
 * invalidation topic (the deliberate ADR 0042 vs ADR 0027/0040 split). Each frame is one
 * SSE event, and its `id:` is the resume cursor echoed back as `Last-Event-ID`:
 *
 *   - `snapshot` — the shape's initial authorized row set at a known cursor.
 *   - `change`   — one insert / update / delete-from-shape stamped with the commit cursor.
 *   - `resync`   — "drop your local slice and re-snapshot", the always-correct floor when
 *     the server cannot prove continuity (v0 sends it on every reconnect — no LSN replay).
 *   - a `: comment` — the heartbeat that holds the stream open past intermediary idle
 *     timeouts and detects a dead peer.
 *
 * A row is serialized with `JSON.stringify`, which never emits a raw newline, so every
 * `data:` payload is a single safe SSE line. The encoders are 100%-tested pure functions;
 * the socket that emits these strings is the coverage-excluded wiring (in the engine).
 */

import { LiveProtocolError } from "./errors";
import type { Row, RowKey, ShapeChange } from "./shape";

/**
 * The resume cursor — opaque at the protocol layer. v0 uses a monotonic token minted by
 * the engine and resyncs on reconnect; v1 carries `(systemId, timelineId, LSN)` for
 * precise replay. Either way the codec only requires it be a single non-empty SSE line.
 */
export type Cursor = string;

/** The `snapshot` frame's decoded payload — the shape's row set. */
export interface SnapshotPayload {
  readonly rows: readonly Row[];
}

/** True iff `cursor` is safe to place on an SSE `id:` line — non-empty and single-line. */
export function isValidCursor(cursor: string): boolean {
  return cursor.length > 0 && !cursor.includes("\n") && !cursor.includes("\r");
}

/** Guard an outbound cursor: a newline would corrupt the SSE frame, so fail loud. */
function assertCursor(cursor: Cursor): void {
  if (!isValidCursor(cursor)) {
    throw new LiveProtocolError(
      "LIVE_PROTOCOL_MALFORMED_FRAME",
      "Cursor must be a non-empty, single-line token.",
      { cursor },
    );
  }
}

/** A `snapshot` frame: the shape's authorized rows, with the cursor they were read at. */
export function snapshotFrame(rows: readonly Row[], cursor: Cursor): string {
  assertCursor(cursor);

  return `event: snapshot\ndata: ${JSON.stringify({ rows })}\nid: ${cursor}\n\n`;
}

/** A `change` frame: one insert / update / delete-from-shape, stamped with its commit cursor. */
export function changeFrame(change: ShapeChange, cursor: Cursor): string {
  assertCursor(cursor);

  return `event: change\ndata: ${JSON.stringify(change)}\nid: ${cursor}\n\n`;
}

/** A `resync` frame: "drop your local slice and re-snapshot". Carries the current cursor. */
export function resyncFrame(cursor: Cursor): string {
  assertCursor(cursor);

  return `event: resync\ndata: \nid: ${cursor}\n\n`;
}

/**
 * A comment frame — the heartbeat. SSE comments (`:`-prefixed) are ignored by
 * `EventSource` but keep the connection from idling out at an intermediary and surface a
 * dead peer to the writer.
 */
export function commentFrame(text: string): string {
  return `: ${text}\n\n`;
}

function malformed(message: string, details: Record<string, unknown> = {}): never {
  throw new LiveProtocolError("LIVE_PROTOCOL_MALFORMED_FRAME", message, details);
}

function parseObject(data: string, what: string): Record<string, unknown> {
  let raw: unknown;

  try {
    raw = JSON.parse(data);
  } catch {
    malformed(`A ${what} frame carried invalid JSON.`);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    malformed(`A ${what} frame must be a JSON object.`);
  }

  return raw as Record<string, unknown>;
}

/** True iff `value` is a plain row object (not null, not an array). */
function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode a `snapshot` event's `data` payload into its rows, or throw
 * `LIVE_PROTOCOL_MALFORMED_FRAME`. The consumer treats a throw as a corrupt stream and
 * resyncs rather than mis-applying a bad frame.
 */
export function decodeSnapshotData(data: string): SnapshotPayload {
  const raw = parseObject(data, "snapshot");

  if (!Array.isArray(raw.rows) || !raw.rows.every(isRow)) {
    malformed("A snapshot frame `rows` must be an array of row objects.");
  }

  return { rows: raw.rows as Row[] };
}

/**
 * Decode a `change` event's `data` payload into a {@link ShapeChange}, or throw
 * `LIVE_PROTOCOL_MALFORMED_FRAME`. `insert`/`update` require a row; `delete` (a
 * delete-from-shape) carries only the key.
 */
export function decodeChangeData(data: string): ShapeChange {
  const raw = parseObject(data, "change");

  const key = raw.key;
  if (typeof key !== "string") malformed("A change frame `key` must be a string.");
  const rowKey = key as RowKey;

  if (raw.op === "delete") {
    return { op: "delete", key: rowKey };
  }

  if (raw.op === "insert" || raw.op === "update") {
    if (!isRow(raw.row)) malformed("An insert/update change frame must carry a `row` object.");

    return { op: raw.op, key: rowKey, row: raw.row };
  }

  return malformed("A change frame `op` must be insert, update, or delete.", { op: raw.op });
}
