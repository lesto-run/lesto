/**
 * The **shape** — a named, parameterized read query, the unit of sync (ADR 0042).
 *
 * A `ShapeDefinition` is the serializable definition of a live query: a table, its
 * key column, the projected columns, an AND-combined structured predicate (the *sync
 * filter*), and a total ordering. It is deliberately **structured** — `{ column, op,
 * value }`, not a raw SQL string — for three reasons that all matter downstream:
 *
 *   1. **The server re-renders the SQL from its own compiler**, so a client can never
 *      inject SQL by naming a shape (ADR 0042 rejected-alternative #4 — the client
 *      names a shape, it does not author the authz predicate).
 *   2. **The predicate is evaluable in JS against a single row** ({@link matchesShape}),
 *      which is exactly what the shape engine needs to decide, per changed row,
 *      insert vs. update vs. delete-from-shape.
 *   3. **It canonicalizes deterministically** ({@link shapeId}), giving a stable
 *      subscribe key and CDN-snapshot cache key.
 *
 * The predicate columns and the order column must all be **projected** (`∈ columns`)
 * so the client can re-evaluate the filter and re-sort against its local store with no
 * round-trip — the invariant `validateShapeDefinition` enforces.
 *
 * v0 scope (single-table, simple equality/range filters): the ops are the six scalar
 * comparisons; joins, `IN`, `LIKE`, and `OR` are vNext.
 */

import { LiveProtocolError } from "./errors";

/** A value a filter compares against — a JSON scalar (a finite number, string, boolean, or null). */
export type FilterValue = string | number | boolean | null;

/** The six scalar comparison operators v0 supports. */
export type FilterOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

/** One conjunct of the sync filter — `column <op> value`. */
export interface Filter {
  readonly column: string;
  readonly op: FilterOp;
  readonly value: FilterValue;
}

/** Ascending or descending — a shape's sort direction. */
export type Direction = "asc" | "desc";

/** The shape's sort column + direction; the key column is always the final tiebreak. */
export interface OrderBy {
  readonly column: string;
  readonly direction: Direction;
}

/** The serializable definition of a live query — the unit of sync. */
export interface ShapeDefinition {
  /** The single table the shape reads (v0 is single-table). */
  readonly table: string;

  /** The primary-key column — the row identity used to key and diff the store. Must be projected. */
  readonly key: string;

  /** The projected columns, in a fixed order. Must include {@link key}, every filter column, and the order column. */
  readonly columns: readonly string[];

  /** The AND-combined sync filter (empty = the whole table). */
  readonly where: readonly Filter[];

  /** The sort column, or `undefined` for key-order only. Either way the key breaks ties → a total order. */
  readonly orderBy: OrderBy | undefined;
}

/** A synced row — an opaque record keyed by column name. */
export type Row = Record<string, unknown>;

/** The stable identity of a row within a shape — the key column's value, stringified. */
export type RowKey = string;

/**
 * A change to a shape's authorized row set: a row that entered is an `insert`, a row
 * that stayed is an `update`, and a row that left the shape (deleted, or updated so it
 * fails the predicate) is a `delete` — the *delete-from-shape* the client applies to
 * keep its local slice exactly the authorized set.
 */
export type ShapeChange =
  | { readonly op: "insert"; readonly key: RowKey; readonly row: Row }
  | { readonly op: "update"; readonly key: RowKey; readonly row: Row }
  | { readonly op: "delete"; readonly key: RowKey };

const FILTER_OPS: ReadonlySet<string> = new Set<FilterOp>(["eq", "ne", "gt", "gte", "lt", "lte"]);

const DIRECTIONS: ReadonlySet<string> = new Set<Direction>(["asc", "desc"]);

/** A finite number, string, boolean, or null — the only values a filter may bind. */
function isFilterValue(value: unknown): value is FilterValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** A non-empty string — the shape a table / column / key name must take. */
function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new LiveProtocolError("LIVE_PROTOCOL_INVALID_SHAPE", message, details);
}

/**
 * Validate an untrusted value into a normalized {@link ShapeDefinition}, or throw
 * `LIVE_PROTOCOL_INVALID_SHAPE`. This is the trust boundary: {@link parseShapeDefinition}
 * runs it on every inbound subscribe request, and producers may call it to fail loud on
 * a malformed shape before it ever reaches the wire.
 *
 * Beyond structure it enforces the local-re-evaluation invariant — the key column, every
 * filter column, and the order column must all be **projected** — because the client
 * re-runs the filter and re-sorts against its local store, and cannot read a column the
 * snapshot never carried.
 */
export function validateShapeDefinition(value: unknown): ShapeDefinition {
  if (typeof value !== "object" || value === null) invalid("Shape definition must be an object.");

  const raw = value as Record<string, unknown>;

  if (!isName(raw.table)) invalid("Shape `table` must be a non-empty string.");
  if (!isName(raw.key)) invalid("Shape `key` must be a non-empty string.");

  if (!Array.isArray(raw.columns) || raw.columns.length === 0) {
    invalid("Shape `columns` must be a non-empty array.");
  }
  const columns = raw.columns as unknown[];
  if (!columns.every(isName)) invalid("Every shape column must be a non-empty string.");
  const columnSet = new Set(columns as string[]);

  const table = raw.table as string;
  const key = raw.key as string;

  if (!columnSet.has(key)) {
    invalid("Shape `key` must be one of the projected `columns`.", { key });
  }

  if (!Array.isArray(raw.where)) invalid("Shape `where` must be an array of filters.");
  const where = (raw.where as unknown[]).map((entry) => validateFilter(entry, columnSet));

  const orderBy = validateOrderBy(raw.orderBy, columnSet);

  return Object.freeze({
    table,
    key,
    columns: Object.freeze([...(columns as string[])]),
    where: Object.freeze(where),
    orderBy,
  });
}

function validateFilter(entry: unknown, columns: ReadonlySet<string>): Filter {
  if (typeof entry !== "object" || entry === null) invalid("Each filter must be an object.");

  const raw = entry as Record<string, unknown>;

  if (!isName(raw.column)) invalid("A filter `column` must be a non-empty string.");
  if (!columns.has(raw.column as string)) {
    invalid("A filter `column` must be one of the projected `columns`.", { column: raw.column });
  }
  if (typeof raw.op !== "string" || !FILTER_OPS.has(raw.op)) {
    invalid("A filter `op` must be one of eq/ne/gt/gte/lt/lte.", { op: raw.op });
  }
  if (!isFilterValue(raw.value)) {
    invalid("A filter `value` must be a finite number, string, boolean, or null.");
  }

  return { column: raw.column as string, op: raw.op as FilterOp, value: raw.value as FilterValue };
}

function validateOrderBy(value: unknown, columns: ReadonlySet<string>): OrderBy | undefined {
  // Absent (or explicit null/undefined) → key-order only; still a total order.
  if (value === undefined || value === null) return undefined;

  if (typeof value !== "object") invalid("Shape `orderBy` must be an object or null.");

  const raw = value as Record<string, unknown>;

  if (!isName(raw.column)) invalid("`orderBy.column` must be a non-empty string.");
  if (!columns.has(raw.column as string)) {
    invalid("`orderBy.column` must be one of the projected `columns`.", { column: raw.column });
  }
  if (typeof raw.direction !== "string" || !DIRECTIONS.has(raw.direction)) {
    invalid("`orderBy.direction` must be 'asc' or 'desc'.", { direction: raw.direction });
  }

  return { column: raw.column as string, direction: raw.direction as Direction };
}

/**
 * The canonical string a {@link shapeId} hashes — a fixed-field, fixed-order encoding
 * so two definitions that mean the same thing hash the same. Filter order is
 * significant (two shapes whose filters are listed in a different order get distinct
 * ids — a redundant subscription, never an incorrect one).
 */
function canonical(def: ShapeDefinition): string {
  return JSON.stringify([
    def.table,
    def.key,
    [...def.columns],
    def.where.map((f) => [f.column, f.op, f.value]),
    def.orderBy ? [def.orderBy.column, def.orderBy.direction] : null,
  ]);
}

/** FNV-1a (32-bit) over a string → 8 lowercase hex chars. Non-cryptographic by design. */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A stable id for a shape — its subscribe key and CDN-snapshot cache key. Deterministic
 * across processes and runtimes: same definition (including the *bound* filter values,
 * which are the capability the server authorizes) ⇒ same id ⇒ shared cached snapshot.
 *
 * The id is NOT a security boundary (a client names a shape; the server authorizes the
 * bound parameters at subscribe time — ADR 0042), so a fast non-cryptographic hash is
 * the right tool. The `table:` prefix keeps it human-legible in logs.
 */
export function shapeId(def: ShapeDefinition): string {
  return `${def.table}:${fnv1a32(canonical(def))}`;
}

/** The row's identity within a shape — `String(row[key])`. Throws if the key value is absent. */
export function rowKey(row: Row, keyColumn: string): RowKey {
  const value = row[keyColumn];

  if (value === null || value === undefined) {
    throw new LiveProtocolError(
      "LIVE_PROTOCOL_MISSING_KEY",
      `Row is missing key column "${keyColumn}".`,
      { keyColumn },
    );
  }

  return String(value);
}

/** The non-null scalars a `<`/`>` comparison is defined over. */
type Comparable = Exclude<FilterValue, null>;

/** SQL-like ordered comparison: `undefined` when either side is null (a NULL compare is never true). */
function ordered(cell: unknown, value: FilterValue): number | undefined {
  if (cell === null || cell === undefined || value === null) return undefined;
  if ((cell as Comparable) < value) return -1;
  if ((cell as Comparable) > value) return 1;

  return 0;
}

/**
 * SQL 3-valued logic: a comparison where either operand is NULL yields NULL — never TRUE — so both
 * `eq` and `ne` require the cell AND the bound value to be present (non-null) before they can hold.
 * (A row column may be null/undefined; a `FilterValue` may itself be null.) This keeps the JS predicate
 * faithful to a SQL-rendered snapshot's `WHERE col = v` / `col <> v`, both of which EXCLUDE nulls:
 * without it, `ne` would INCLUDE a null cell and `eq NULL` would MATCH null cells — the exact divergence
 * that would leak a row present incrementally but absent from an authoritative SQL snapshot (`ordered`
 * already applies the same rule to `gt`/`gte`/`lt`/`lte`).
 */
function present(cell: unknown, value: FilterValue): boolean {
  return cell !== null && cell !== undefined && value !== null;
}

/** Evaluate one filter against a cell — `eq`/`ne` are exact (`Object.is`, NULL-guarded), the rest ordered. */
function matchesFilter(filter: Filter, cell: unknown): boolean {
  switch (filter.op) {
    case "eq":
      return present(cell, filter.value) && Object.is(cell, filter.value);
    case "ne":
      return present(cell, filter.value) && !Object.is(cell, filter.value);
    case "gt": {
      const cmp = ordered(cell, filter.value);

      return cmp !== undefined && cmp > 0;
    }
    case "gte": {
      const cmp = ordered(cell, filter.value);

      return cmp !== undefined && cmp >= 0;
    }
    case "lt": {
      const cmp = ordered(cell, filter.value);

      return cmp !== undefined && cmp < 0;
    }
    default: {
      // "lte" — the switch is exhaustive over `FilterOp`, so this is the last case.
      const cmp = ordered(cell, filter.value);

      return cmp !== undefined && cmp <= 0;
    }
  }
}

/**
 * Does a row satisfy the shape's sync filter? The AND of every conjunct — an empty
 * `where` matches every row. This is the per-row authorization/membership decision the
 * shape engine runs on each changed row (and the client re-runs against its local store).
 */
export function matchesShape(def: ShapeDefinition, row: Row): boolean {
  return def.where.every((filter) => matchesFilter(filter, row[filter.column]));
}

/** Compare two cells for sorting — null sorts first, then natural `<`/`>` order. */
function compareCells(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if ((a as Comparable) < (b as Comparable)) return -1;
  if ((a as Comparable) > (b as Comparable)) return 1;

  return 0;
}

/**
 * The shape's **total** order: the `orderBy` column (respecting direction) with the
 * unique key column as the final tiebreak. Two distinct rows can never compare equal
 * (the key is unique), so snapshot bytes are deterministic — the CDN-cacheability
 * requirement (ADR 0042) — and the client re-sorts its local store identically.
 */
export function compareRows(def: ShapeDefinition, a: Row, b: Row): number {
  if (def.orderBy) {
    const cmp = compareCells(a[def.orderBy.column], b[def.orderBy.column]);
    const directed = def.orderBy.direction === "desc" ? -cmp : cmp;

    if (directed !== 0) return directed;
  }

  return compareCells(a[def.key], b[def.key]);
}

/** The canonical wire form of a subscribe request — a validated, normalized JSON string. */
export function serializeShapeDefinition(def: ShapeDefinition): string {
  return JSON.stringify(validateShapeDefinition(def));
}

/** Parse + validate an inbound subscribe request back into a {@link ShapeDefinition}. */
export function parseShapeDefinition(json: string): ShapeDefinition {
  let raw: unknown;

  try {
    raw = JSON.parse(json);
  } catch {
    invalid("Shape definition is not valid JSON.");
  }

  return validateShapeDefinition(raw);
}
