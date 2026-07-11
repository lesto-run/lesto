/**
 * `live()` — the moat builder (ADR 0042 Tier 4, v0). A typed, fluent builder over the SAME
 * `@lesto/db` schema the app writes with, that mints a {@link ShapeDefinition} and returns a
 * live, offline-capable, locally-queryable {@link LiveQuery}:
 *
 *   const todos = live(todosTable)
 *     .where(todosTable.list, "eq", "home")
 *     .orderBy(todosTable.createdAt, "asc")
 *     .query();
 *   //  ^ LiveQuery<Todo> — reads from the local store, stays in sync via GET /__lesto/live-data
 *
 * This is the honest reading of the ADR's moat claim: NOT one object straddling client and
 * server (the server's pool-bound query builder has no browser runtime), but **one query
 * language, one AST of typed `Table`/`Column` values, one row type across both runtimes**.
 * The builder reads only the table's metadata (`byColumn`, `byKey`, `spec`) — plain data on
 * the table value — so it pulls in no server/database runtime, and no app framework that
 * merely *consumes* an external sync service can offer `live()` as a first-class builder over its own ORM's schema.
 *
 * v0 scope: single-table, AND-combined simple `eq/ne/gt/gte/lt/lte` filters, the whole row
 * projected. The one dev/prod-parity caveat (like the ADR's others): a `timestamp` column
 * arrives on the client as **epoch-ms** (the wire folds `Date` → number), so `R`'s `Date`
 * field reads as a number at runtime in v0 — a fully wire-typed row is a vNext refinement.
 */

import { validateShapeDefinition } from "@lesto/live-protocol";
import type {
  Direction,
  Filter,
  FilterOp,
  FilterValue,
  Row,
  ShapeDefinition,
} from "@lesto/live-protocol";
import type { Column, InferRow, Table } from "@lesto/db";

import { LiveClientError } from "./errors";
import { createLiveQuery } from "./live-query";
import type { CreateLiveQueryOptions, LiveQuery } from "./live-query";

/** Any placed column — what `.where`/`.orderBy` accept (the value type is checked separately). */
type AnyColumn = Column<unknown, boolean, boolean>;

/** The immutable state a builder threads: the table + accumulated filters + order. */
interface BuilderState {
  readonly table: Table;
  readonly where: readonly Filter[];
  readonly orderBy: { readonly column: string; readonly direction: Direction } | undefined;
}

/**
 * A typed, fluent live-query builder. Each modifier returns a NEW builder (immutable chain,
 * no `this`); the terminals compile the accumulated shape. Generic over the projected row
 * type `R` a typed `live(table)` recovers from the table.
 */
export interface LiveQueryBuilder<R extends Row> {
  /** Add an AND-combined `column <op> value` filter (the sync filter + the authorized capability). */
  where(column: AnyColumn, op: FilterOp, value: FilterValue): LiveQueryBuilder<R>;

  /** Set the sort column (the unique key always breaks ties → a total order). `direction` defaults to `"asc"`. */
  orderBy(column: AnyColumn, direction?: Direction): LiveQueryBuilder<R>;

  /** Compile + validate the accumulated {@link ShapeDefinition} without opening a stream. */
  toShape(): ShapeDefinition;

  /** Open the live subscription: mint the shape and return its {@link LiveQuery}. */
  query(options?: CreateLiveQueryOptions): LiveQuery<R>;
}

/** Resolve a placed column to its JS key on the table, or throw `LIVE_UNKNOWN_COLUMN`. */
function jsKeyOf(table: Table, column: AnyColumn): string {
  const key = table.byColumn[column.spec.name];

  if (key === undefined) {
    throw new LiveClientError(
      "LIVE_UNKNOWN_COLUMN",
      `Column "${column.spec.name}" is not on table "${table.tableName}".`,
      { table: table.tableName, column: column.spec.name },
    );
  }

  return key;
}

/** The table's primary-key column (its JS key), or throw `LIVE_NO_KEY`. */
function primaryKeyOf(table: Table): string {
  for (const [key, spec] of Object.entries(table.byKey)) {
    if (spec.primaryKey) return key;
  }

  throw new LiveClientError(
    "LIVE_NO_KEY",
    `Table "${table.tableName}" has no primary-key column; live() needs one to identify rows.`,
    { table: table.tableName },
  );
}

/** Compile the builder state into a validated shape: whole-row projection, PK as the key. */
function compile(state: BuilderState): ShapeDefinition {
  return validateShapeDefinition({
    table: state.table.tableName,
    key: primaryKeyOf(state.table),
    columns: Object.keys(state.table.byKey),
    where: state.where,
    orderBy: state.orderBy,
  });
}

function makeBuilder<R extends Row>(state: BuilderState): LiveQueryBuilder<R> {
  return {
    where: (column, op, value) =>
      makeBuilder<R>({
        ...state,
        where: [...state.where, { column: jsKeyOf(state.table, column), op, value }],
      }),

    orderBy: (column, direction = "asc") =>
      makeBuilder<R>({ ...state, orderBy: { column: jsKeyOf(state.table, column), direction } }),

    toShape: () => compile(state),

    query: (options) => createLiveQuery<R>(compile(state), options),
  };
}

/**
 * Start a `live()` query over a `@lesto/db` table. The returned builder is typed to the
 * table's row (`InferRow<T>`), so `.query()` yields a `LiveQuery<Todo>` with no second query
 * language and no socket code — the moat, as a free function over the ORM's own schema.
 */
export function live<T extends Table>(table: T): LiveQueryBuilder<InferRow<T>> {
  return makeBuilder<InferRow<T>>({ table, where: [], orderBy: undefined });
}
