/**
 * Per-row **delete-from-shape classification** (ADR 0042 Tier 4, v1 Inc2) — the heart of
 * per-row authorization for the logical-replication change source.
 *
 * The v0 engine detects change by *set-diffing* full poll snapshots ({@link file://./diff.ts}).
 * The v1 change source ({@link file://./replication.ts}) instead delivers **incremental** changes
 * with the row's OLD and NEW images, so change is applied one row at a time. For each active shape
 * a changed row is classified by whether it was in the shape *before* and whether it is in *after*
 * — the **in/out/stay** decision (ADR 0042, "per-row authorization"):
 *
 * | matched OLD? | matches NEW? | result                                    |
 * |:------------:|:------------:|-------------------------------------------|
 * |      —       |     yes      | `insert` (a new row entered the shape)    |
 * |      —       |      no      | *(nothing — never in this client's slice)*|
 * |     yes      |     yes      | `update` (stayed; ship the new row)       |
 * |      no      |     yes      | `insert` (an update moved it *in*)        |
 * |     yes      |      no      | `delete` (an update moved it *out*) ⇐ the **delete-from-shape** that stops a leak |
 * |      no      |      no      | *(nothing — outside the slice both times)*|
 * |     yes      |      —       | `delete` (the row was deleted from the table) |
 *
 * The **delete-from-shape** row (in ⇒ out) is the security-load-bearing case: without it a row the
 * principal lost access to (an update reassigning `owner_id`/`room_id`, a membership revoke) would
 * silently **persist** in the client's local store. Emitting the `delete` removes it, keeping the
 * client slice exactly the authorized set.
 *
 * **This depends on a full OLD image.** Evaluating `matchesShape(OLD)` over a predicate on a
 * **non-key** column — or recovering the old value of a shape **key that is a UNIQUE non-PK column**
 * (so a key change / delete is keyed correctly rather than stranded) — needs that value in the old
 * tuple, which Postgres emits only under `REPLICA IDENTITY FULL` (else the old image is the
 * *primary key* only, or — for an unchanged-PK `DEFAULT` update — absent entirely). {@link predicateNeedsOldImage}
 * + {@link assertReplicaIdentity} are the registration-time guard that **refuses** such a shape
 * unless its table supplies the old image — never a silent leak (ADR 0042 *Consequences*). Whether
 * the table has `REPLICA IDENTITY FULL` is a catalog fact (`pg_class.relreplident = 'f'`) the engine
 * supplies; this module owns the *decision*, not the lookup.
 *
 * **Coercion is injected.** A replication image is raw and, from `pgoutput`, **text-encoded**
 * (`room_id` arrives `"42"`, a boolean `"t"`, a timestamp a string). `matchesShape` compares against
 * typed filter values (`42`), so an image must be projected to the shape's columns and coerced to
 * the shape's scalar types *before* classification. That coercion needs the table's column kinds, so
 * it is an injected {@link ImageCoercer} seam — the engine provides a `@lesto/db`-backed one; a test
 * provides a trivial one. This module stays pure protocol logic, DB- and decoder-agnostic.
 */

import { matchesShape, rowKey } from "@lesto/live-protocol";
import type { Row, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";

import { LiveServerError } from "./errors";
import type { OldImageKind, ReplicationChange, RowImage } from "./replication";

/**
 * Project a raw replication {@link RowImage} to the shape's typed, wire-form {@link Row}: keep the
 * shape's columns, coerce each to the shape's scalar type (e.g. `pgoutput` text `"42"` → `42`), and
 * normalize to wire form (a `Date` → epoch-ms). Injected so this module needs no `@lesto/db` handle.
 */
export type ImageCoercer = (image: RowImage) => Row;

/**
 * Whether a shape's predicate needs the row's **full** old image to classify a delete-from-shape —
 * or an identity change *within* the shape — soundly. True iff EITHER:
 *
 *   - **any filter is over a column other than the shape's key** — that column's old value is needed
 *     to evaluate `matchesShape(OLD)`, and a `DEFAULT` table omits it (the old tuple is the key only); or
 *   - **the shape's key is not the table's PRIMARY KEY** — a UNIQUE non-PK key (`slug`, `email`). Under
 *     `REPLICA IDENTITY DEFAULT` the replica-identity key IS the primary key, so the old tuple never
 *     carries the shape's key: (i) an update that changes the unique key but not the PK emits **no old
 *     key** — the key-change guard can't fire, so the old row is stranded under its old key (a stale
 *     duplicate); and (ii) an ordinary DELETE carries a `'K'` tuple = the PK only, NOT the unique key
 *     the client store is keyed by, so the delete targets a key the client never held and the real row
 *     survives. Both are silent, durable leaks. Only the full old image (`REPLICA IDENTITY FULL`, which
 *     emits the whole old row) carries the unique key's old value. (A future `REPLICA IDENTITY USING
 *     INDEX <unique-index>` could carry the unique key AS the identity and relax this to just that
 *     column — deliberately NOT implemented here; a follow-up.)
 *
 * A **primary-key**-keyed, key-only (or filterless) predicate needs *nothing* from the old image: the
 * primary key is immutable and IS the replica-identity key, so an update cannot move such a row across
 * the shape boundary without changing the key (which the classifier refuses), and when a key change
 * *does* happen even a `DEFAULT` table emits the old key.
 *
 * `keyIsPrimaryKey` is the catalog fact `table.byKey[def.key].primaryKey` — JS schema, not the
 * live-DB replica-identity probe.
 */
export function predicateNeedsOldImage(def: ShapeDefinition, keyIsPrimaryKey: boolean): boolean {
  return !keyIsPrimaryKey || def.where.some((filter) => filter.column !== def.key);
}

/**
 * The registration-time guard: **refuse** a shape whose predicate needs the old image
 * ({@link predicateNeedsOldImage}) when its table is not `REPLICA IDENTITY FULL`. Rather than serve
 * it and silently fail to emit delete-from-shape — or strand a row whose UNIQUE non-PK key changed —
 * (a durable leak into the client's OPFS store), the engine rejects it with a coded error so the
 * operator fixes the table's replica identity. A primary-key-keyed, key-only predicate (or a table
 * that already supplies the full old image) passes. `keyIsPrimaryKey` is the catalog fact
 * `table.byKey[def.key].primaryKey`.
 */
export function assertReplicaIdentity(
  def: ShapeDefinition,
  keyIsPrimaryKey: boolean,
  hasFullReplicaIdentity: boolean,
): void {
  if (!predicateNeedsOldImage(def, keyIsPrimaryKey) || hasFullReplicaIdentity) return;

  // Name the arm that applies so the operator's fix is unambiguous. The non-PK-key arm is the more
  // fundamental of the two (the key itself cannot be recovered from a DEFAULT old tuple), so it wins
  // when both hold.
  const reason = !keyIsPrimaryKey
    ? `keys on "${def.key}", which is UNIQUE but not the table's primary key; REPLICA IDENTITY FULL is required so a key change can be seen and the old row is never stranded, and so a delete carries the unique key (not only the primary key)`
    : `filters a non-key column`;

  throw new LiveServerError(
    "LIVE_SERVER_REPLICA_IDENTITY_INSUFFICIENT",
    `Shape on "${def.table}" ${reason}, so classifying a row that leaves the shape — or changes its key within it — needs the full old row image; set REPLICA IDENTITY FULL on "${def.table}".`,
    { table: def.table, key: def.key },
  );
}

/**
 * The runtime old-image completeness guard — the per-change twin of {@link assertReplicaIdentity}.
 * It runs **two complementary checks**, because neither alone is sound; a shape whose predicate needs
 * the old image ({@link predicateNeedsOldImage}) is served only when BOTH pass on every `update`/`delete`.
 *
 * **1. The old-tuple {@link OldImageKind} marker must be `'full'`.** The registration guard proves the
 * table *was* `REPLICA IDENTITY FULL` when the shape registered, but replica identity is mutable: a
 * table `ALTER`ed `FULL`→`DEFAULT` afterward starts emitting a **key-only** (`'key'`) or **absent**
 * (`'none'`) old image. A `'K'` tuple sends its non-identity columns as `null`, which `readTuple`
 * decodes to a genuine `null` — *value-indistinguishable* from a real transmitted `null` — so a
 * value-only check MISSES it (the null passes, `matchesShape(null)` reads false, the delete-from-shape
 * is dropped, the row leaks). Only the **marker** catches a downgrade.
 *
 * **2. Every required old column must be a transmitted value (not `undefined`).** `FULL` guarantees a
 * column is *included* in the old tuple, but NOT that its value is *sent*: an **unchanged, externally
 * TOASTed** (`>~2KB`) column is emitted as pgoutput's `'u'` (`readTuple` → `undefined`) even under
 * `FULL`, because the reorder buffer only detoasts the NEW tuple. So a `'full'`-marked old tuple can
 * still omit a predicate column — `matchesShape` would then read `undefined`/`NaN` and drop a
 * delete-from-shape. Only the **value** check catches that. `requiredColumns` are the predicate's key +
 * filter columns as **SQL names** ({@link requiredOldImageColumns}); a genuine `null` (a real value)
 * passes, only `undefined` fails.
 *
 * Throws a coded {@link LiveServerError} so either kind of durable leak surfaces as a loud, routed error.
 */
export function assertOldImageComplete(
  def: ShapeDefinition,
  oldImageKind: OldImageKind,
  requiredColumns: readonly string[],
  oldImage: RowImage,
): void {
  // (1) coarse — the whole old tuple: a 'K' downgrade (null-filled non-key columns) or an absent tuple.
  if (oldImageKind !== "full") {
    throw new LiveServerError(
      "LIVE_SERVER_OLD_IMAGE_INCOMPLETE",
      `A replication change on "${def.table}" carried ${oldImageKind === "none" ? "no old image" : "a key-only old image"}, so a row leaving the shape cannot be classified — restore REPLICA IDENTITY FULL on "${def.table}".`,
      { table: def.table, oldImageKind },
    );
  }

  // (2) fine — a specific column absent from an otherwise-FULL tuple (unchanged external-TOAST → 'u').
  for (const column of requiredColumns) {
    if (oldImage[column] === undefined) {
      throw new LiveServerError(
        "LIVE_SERVER_OLD_IMAGE_INCOMPLETE",
        `A replication change on "${def.table}" omitted column "${column}" from its old image (an unchanged external-TOAST value is not transmitted even under REPLICA IDENTITY FULL), so a row leaving the shape cannot be classified.`,
        { table: def.table, column },
      );
    }
  }
}

/**
 * Merge a NEW image over the OLD, filling any column the stream did not transmit. `pgoutput` marks
 * an **unchanged-TOAST** column as absent (a `undefined` value) rather than resend a large value; the
 * current value of such a column IS its old value, so the merged image is the true post-update row
 * (and what `matchesShape(NEW)` and the shipped row must see).
 */
function mergeNewOverOld(next: RowImage, prev: RowImage): RowImage {
  const merged: RowImage = { ...prev };

  for (const [column, value] of Object.entries(next)) {
    if (value !== undefined) merged[column] = value;
  }

  return merged;
}

/**
 * Whether the change actually carried an old row image. `pgoutput` sends **no** old tuple for a
 * `REPLICA IDENTITY DEFAULT` update whose key did not change (the decoder then leaves `oldImage`
 * empty); a key tuple (a key change) or a full old row (`FULL`) leaves it populated. Emptiness is
 * the signal that the old image must not be coerced (it would fabricate a NaN-keyed row).
 */
function hasOldImage(oldImage: RowImage): boolean {
  return Object.keys(oldImage).length !== 0;
}

/**
 * Classify one {@link ReplicationChange} against one active shape, producing the {@link ShapeChange}
 * to fan to that shape's subscribers, or `undefined` when the change does not affect this shape's
 * authorized set. `coerce` projects + type-coerces the raw image (see {@link ImageCoercer}); it is
 * assumed the engine has already validated the shape's replica identity ({@link assertReplicaIdentity}),
 * so a non-key predicate can trust the old image is complete.
 */
export function classifyChange(
  def: ShapeDefinition,
  change: ReplicationChange,
  coerce: ImageCoercer,
): ShapeChange | undefined {
  if (change.op === "insert") {
    const row = coerce(change.newImage);

    return matchesShape(def, row) ? { op: "insert", key: rowKey(row, def.key), row } : undefined;
  }

  if (change.op === "delete") {
    const row = coerce(change.oldImage);

    // A deleted row only needs removing from the client if it was in the shape to begin with.
    return matchesShape(def, row) ? { op: "delete", key: rowKey(row, def.key) } : undefined;
  }

  // An update: classify by shape membership before vs after.
  const newRow = coerce(mergeNewOverOld(change.newImage, change.oldImage));

  // A `REPLICA IDENTITY DEFAULT` update whose (immutable) key did NOT change carries **no old
  // tuple** — `oldImage` is empty. Coercing `{}` would fabricate a NaN-keyed row, so `wasIn`
  // (and the key-change guard) would read garbage: a key-only/filterless shape's plain update
  // would misfire (a spurious `LIVE_SERVER_PRIMARY_KEY_CHANGED`, or an `insert` for a row already
  // present). Since the key is immutable, an absent old image means membership cannot have changed
  // — so classify against the NEW row. When an old image IS present (a key change under DEFAULT
  // sends a key tuple; every update under FULL sends the old row), trust it. A predicate that needs
  // the old image never reaches here with one missing: the engine's guard refuses that at the door.
  const oldRow = hasOldImage(change.oldImage) ? coerce(change.oldImage) : newRow;
  const wasIn = matchesShape(def, oldRow);
  const isIn = matchesShape(def, newRow);

  if (isIn) {
    const newKey = rowKey(newRow, def.key);

    // A row that STAYED in the shape must keep its key: keying the store by the key, a changed key
    // would leave the old row stranded under its old key (a stale duplicate the client never
    // removes). A v1 shape assumes an immutable primary key — refuse loudly rather than strand.
    if (wasIn && rowKey(oldRow, def.key) !== newKey) {
      throw new LiveServerError(
        "LIVE_SERVER_PRIMARY_KEY_CHANGED",
        `A row in shape on "${def.table}" changed its key "${def.key}"; a v1 shape assumes an immutable key.`,
        { table: def.table, key: def.key },
      );
    }

    // Stayed in (update) or moved in (insert) — either way the client needs the current row.
    return { op: wasIn ? "update" : "insert", key: newKey, row: newRow };
  }

  if (wasIn) {
    // Moved OUT — the delete-from-shape: remove the row the principal no longer sees.
    return { op: "delete", key: rowKey(oldRow, def.key) };
  }

  // Outside the shape both before and after — nothing to tell this client.
  return undefined;
}

/**
 * Bind a shape to a **guarded** per-change classifier — the single intended entry point, so
 * *neither* the registration guard *nor* its per-change runtime twin can be forgotten.
 *
 * `classifyChange` trusts that the shape's table can supply the old image its predicate needs; if a
 * caller skips the guards, the classifier reads an incomplete old image and *silently* stops emitting
 * delete-from-shape — a durable authorization leak (the exact failure this module exists to prevent).
 * This factory folds **both** guards into the bound closure it returns:
 *   - {@link assertReplicaIdentity} once at registration — refuse a shape that needs the old image
 *     (a non-key-predicate filter, OR a key that is not the table's primary key — `keyIsPrimaryKey`
 *     is the catalog fact `table.byKey[def.key].primaryKey`) whose table is not `REPLICA IDENTITY
 *     FULL` (`hasFullReplicaIdentity` is the catalog fact `pg_class.relreplident = 'f'`).
 *   - {@link assertOldImageComplete} per `update`/`delete` — the runtime re-check (marker + per-column
 *     presence) that a usable old image is *still* being delivered (a `FULL`→`DEFAULT` downgrade, or an
 *     unchanged external-TOAST predicate column, would otherwise leak), skipped for a shape whose
 *     predicate does not read the old image. `requiredOldColumns` are that shape's key + filter columns
 *     as SQL names ({@link requiredOldImageColumns}) — the value check's target set.
 *
 * The returned `(change) => ShapeChange | undefined` is **unobtainable without having passed the
 * registration guard**, and it self-applies the runtime guard, so the hot path cannot fail open —
 * closing the gap where a direct caller of this public entry point previously lost the runtime guard
 * that lived only in the engine's glue. The engine stores the returned closure per shape and calls it
 * per change; `coerce` is the `@lesto/db`-backed {@link ImageCoercer} for that shape's table.
 */
export function prepareShapeClassifier(
  def: ShapeDefinition,
  keyIsPrimaryKey: boolean,
  hasFullReplicaIdentity: boolean,
  coerce: ImageCoercer,
  requiredOldColumns: readonly string[],
): (change: ReplicationChange) => ShapeChange | undefined {
  assertReplicaIdentity(def, keyIsPrimaryKey, hasFullReplicaIdentity);

  const needsOldImage = predicateNeedsOldImage(def, keyIsPrimaryKey);

  return (change) => {
    // An insert carries no old image; an update/delete on a non-key-predicate shape must arrive with a
    // usable FULL old image — the guard throws (loud, routed) rather than drop a delete-from-shape if
    // the table was ALTERed away from FULL after registration, or a predicate column came through as
    // an unchanged external-TOAST 'u'. A key-only/filterless shape needs no old image, so it is skipped.
    if (needsOldImage && change.op !== "insert") {
      assertOldImageComplete(def, change.oldImageKind, requiredOldColumns, change.oldImage);
    }

    return classifyChange(def, change, coerce);
  };
}
