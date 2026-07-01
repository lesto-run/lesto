/**
 * The `@lesto/db`-backed {@link ImageCoercer} — projects a raw `pgoutput` row image to a shape's
 * typed, wire-form {@link Row}, so the logical-replication change source ({@link file://./replication.ts})
 * feeds the same-typed rows the v0 poll does (ADR 0042 Tier 4, v1 Inc2 wiring).
 *
 * **Why coercion is needed.** `pgoutput` text-encodes every column value (a `room_id` arrives
 * `"42"`, a boolean-storage `INTEGER` `"1"`, a timestamp-storage `INTEGER` an epoch-ms string),
 * and images are keyed by SQL column **names** (`room_id`), not the shape's JS keys (`roomId`).
 * The shape's predicate ({@link matchesShape}) compares against typed filter values (`42`) keyed by
 * JS key, so an image must be projected + coerced *before* classification.
 *
 * **Wire parity is the contract.** Both change sources must emit a **byte-identical** wire row for
 * the same logical row, or a client would see a `Date` vs epoch-ms (or a boolean `"1"` vs `NaN`)
 * desync between the initial snapshot (v0 read path) and the live tail (v1 replication path). The
 * v0 path is `db.all()` → hydrate → {@link normalizeWire}; hydrate dispatches each cell on its
 * column {@link ColumnKind} through {@link coerceCell}. This coercer reuses that **exact**
 * `coerceCell` and the same `normalizeWire`, so a coerced replication image is indistinguishable
 * from a hydrated `db` row. Crucially, `@lesto/db` stores `boolean` and `timestamp` as `INTEGER`
 * (a `0/1` flag, an epoch-ms instant — see `columns.ts` `STORAGE`), so `pgoutput`'s text of those
 * columns is a numeric string (`"1"`, `"1751385600000"`), which `coerceCell` — already
 * driver-agnostic, since node-postgres hands `INTEGER`/`BIGINT` back as a *string* — coerces
 * identically. There is no native-`boolean` `"t"/"f"` or timestamp-string to reparse: the storage
 * model makes the text encoding line up.
 *
 * **TOAST caveat (documented, ADR 0042 red-team F4).** Under a non-`FULL` replica identity, an
 * update omits an unchanged-TOAST column from both images; if that column is merely *projected*
 * (not part of the predicate — those are guarded to `FULL` at registration), the coerced row ships
 * it as `NaN`/`undefined`. This is local *corruption* of a projected column, never an authorization
 * leak, and it only arises for a key-only/filterless shape projecting a large TEXT column on a
 * non-`FULL` table. Setting `REPLICA IDENTITY FULL` on such a table removes it; the engine does not
 * force `FULL` for a merely-projected column because that would defeat the key-only-predicate path.
 *
 * **bigint caveat (documented, ADR 0042 red-team F6).** An `int8` column coerces through the same
 * `coerceCell` `Number(...)` on *both* change sources, so there is no cross-source desync — but a
 * value beyond `Number.MAX_SAFE_INTEGER` loses precision (a pre-existing `@lesto/db` property, not
 * introduced here), and the protocol's `FilterValue` has no `bigint`, so a shape cannot filter an
 * `int8` past 2^53 exactly. Extending `FilterValue`/the wire to carry `bigint` is tracked for Inc3.
 */

import { coerceCell } from "@lesto/db";
import type { Table } from "@lesto/db";
import type { Row, ShapeDefinition } from "@lesto/live-protocol";

import type { ImageCoercer } from "./classify";
import { normalizeWire } from "./diff";
import type { RowImage } from "./replication";

/** One projected column: the shape's JS key, its SQL name (the image is keyed by it), its kind. */
interface Projection {
  readonly key: string;
  readonly sqlName: string;
  readonly kind: Parameters<typeof coerceCell>[0];
}

/** Resolve a shape's projected columns to their `@lesto/db` `(sqlName, kind)` via the table. */
function project(def: ShapeDefinition, table: Table): readonly Projection[] {
  return def.columns.map((key) => {
    // The engine has already validated every shape column against the table (`resolveTable`), so
    // `byKey[key]` is present here — this coercer is only ever built after that gate.
    const spec = table.byKey[key]!;

    return { key, sqlName: spec.name, kind: spec.kind };
  });
}

/**
 * Build the `@lesto/db`-backed {@link ImageCoercer} for one shape over one table. The returned
 * coercer reads each projected column by its **SQL name** from the raw image, coerces it through
 * the canonical {@link coerceCell}, keys the result by the shape's **JS key**, and folds the row to
 * wire form ({@link normalizeWire} — a `Date` → epoch-ms) — the identical pipeline the v0 poll's
 * `normalizeWire(projectRow(hydrate(row), columns))` produces, so both change sources agree.
 */
export function createImageCoercer(def: ShapeDefinition, table: Table): ImageCoercer {
  const projection = project(def, table);

  return (image: RowImage): Row => {
    const row: Row = {};

    for (const { key, sqlName, kind } of projection) {
      row[key] = coerceCell(kind, image[sqlName]);
    }

    return normalizeWire(row);
  };
}
