/**
 * The four query verbs — `select`, `insert`, `update`, `delete` — built on
 * the schema-as-value.
 *
 *   const user = await db.select().from(users).where(eq(users.email, e)).get();
 *   await db.insert(users).values({ email, passwordHash, ... }).returning().get();
 *   await db.update(users).set({ passwordHash }).where(eq(users.id, 1)).run();
 *   await db.delete(users).where(eq(users.id, 1)).run();
 *
 * Each verb is a fluent chain that *terminates* in an awaited driver call:
 *
 *   - `.get()` — first row or `undefined` (always `LIMIT 1`).
 *   - `.all()` — every row.
 *   - `.run()` — execute, return `{ changes }` (the row count).
 *
 * The chain assembles a (sql, params) pair and hands it to the injected
 * {@link SqlDatabase}. Columns are addressed through the typed `Table`
 * value, so the only strings interpolated into SQL are identifiers we own;
 * every user-supplied value rides a `?` placeholder.
 */

import type { Column } from "./columns";
import type { Condition } from "./conditions";
import { DbError } from "./errors";
import { quoteIdentifier } from "./identifier";
import type { SqlDatabase } from "./sql";
import type { InferInsert, InferRow, InferUpdate, Table } from "./table";

/** Coerce a JS value to the form the SQL driver expects. */
function bind(value: unknown): unknown {
  if (value === undefined) return null;

  if (typeof value === "boolean") return value ? 1 : 0;

  return value;
}

/**
 * Hydrate a raw row (snake_case keys) into the camelCase row the consumer
 * expects, using the table's `byColumn` map. Unknown columns are passed
 * through (defensive — a future column added in DDL would otherwise drop).
 */
function hydrate<T extends Table>(table: T, raw: unknown): InferRow<T> {
  const row = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [columnName, value] of Object.entries(row)) {
    const key = table.byColumn[columnName] ?? columnName;
    out[key] = value;
  }

  return out as InferRow<T>;
}

// ---------------------------------------------------------------------------
// SELECT
//
// One {@link SelectQuery} type carries every chain stage. Each modifier
// (`where` / `orderBy` / `limit` / `offset`) returns a *new* `SelectQuery`
// with the state updated — immutable chain, no `this`. Three terminators
// (`get` / `all` / `count`) compile the accumulated state to SQL and run
// it. Modifier order is canonical at render time, so callers may chain in
// whatever order reads best; every call is "last-wins" if repeated.
// ---------------------------------------------------------------------------

interface OrderBy {
  readonly column: string;
  readonly direction: "asc" | "desc";
}

interface SelectState<T extends Table> {
  readonly table: T;
  readonly where: Condition | undefined;
  readonly orderBy: OrderBy | undefined;
  readonly limit: number | undefined;
  readonly offset: number | undefined;
}

/** A typed SELECT chain. Modifiers return a new query; terminators run it. */
export interface SelectQuery<T extends Table> {
  /** Add or replace the `WHERE` clause. */
  where(condition: Condition): SelectQuery<T>;

  /** Add or replace the `ORDER BY` clause. `direction` defaults to `"asc"`. */
  orderBy(column: Column<unknown, boolean, boolean>, direction?: "asc" | "desc"): SelectQuery<T>;

  /** Cap the row count. */
  limit(count: number): SelectQuery<T>;

  /** Skip `count` rows before yielding the first. */
  offset(count: number): SelectQuery<T>;

  /** First row matching the chain (always `LIMIT 1`), or `undefined`. */
  get(): Promise<InferRow<T> | undefined>;

  /** Every row matching the chain, in chain order. */
  all(): Promise<InferRow<T>[]>;

  /**
   * Count rows matching the `WHERE` clause. Ignores `orderBy` / `limit` /
   * `offset` — counting all matching rows is the only useful semantic
   * (LIMIT-ed counts are almost always a bug).
   */
  count(): Promise<number>;
}

interface SelectBuilder {
  from<T extends Table>(table: T): SelectQuery<T>;
}

/** Render WHERE + (optionally) ORDER BY / LIMIT / OFFSET into a (sql, params) pair. */
function renderSelect<T extends Table>(
  state: SelectState<T>,
  options: { projection: string; respectLimitOrder: boolean },
): { sql: string; params: unknown[] } {
  const parts = [`SELECT ${options.projection} FROM ${quoteIdentifier(state.table.tableName)}`];
  const params: unknown[] = [];

  if (state.where) {
    parts.push(`WHERE ${state.where.sql}`);
    params.push(...state.where.params);
  }

  if (options.respectLimitOrder) {
    if (state.orderBy) {
      parts.push(
        `ORDER BY ${quoteIdentifier(state.orderBy.column)} ${state.orderBy.direction.toUpperCase()}`,
      );
    }

    // `LIMIT` and `OFFSET` are decoupled at the user level but coupled in
    // SQLite (which requires a LIMIT for OFFSET to take effect). When the
    // caller asked for offset alone, we emit `LIMIT -1` — the SQLite idiom
    // for "no row cap" — so the offset still applies. A Postgres driver
    // would render this as a bare `OFFSET`; that's the driver's concern.
    if (state.limit !== undefined) {
      parts.push(`LIMIT ${state.limit}`);
      if (state.offset !== undefined) parts.push(`OFFSET ${state.offset}`);
    } else if (state.offset !== undefined) {
      parts.push(`LIMIT -1 OFFSET ${state.offset}`);
    }
  }

  return { sql: parts.join(" "), params };
}

interface CountRow {
  readonly c: number | bigint;
}

function makeQuery<T extends Table>(sql: SqlDatabase, state: SelectState<T>): SelectQuery<T> {
  const next = (patch: Partial<SelectState<T>>): SelectQuery<T> =>
    makeQuery(sql, { ...state, ...patch });

  return {
    where: (condition) => next({ where: condition }),
    orderBy: (column, direction = "asc") =>
      next({ orderBy: { column: column.spec.name, direction } }),
    limit: (count) => next({ limit: count }),
    offset: (count) => next({ offset: count }),

    async get(): Promise<InferRow<T> | undefined> {
      // `.get()` is `LIMIT 1` regardless of what the user set — the most
      // useful semantic, matching better-sqlite3's `get()` and Drizzle's
      // `.get()`.
      const { sql: stmt, params } = renderSelect(
        { ...state, limit: 1, offset: state.offset },
        { projection: "*", respectLimitOrder: true },
      );
      const row = await sql.prepare(stmt).get(params);

      // No row reads as `undefined`, whichever sentinel the driver uses for a
      // miss — better-sqlite3 returns `undefined`, `bun:sqlite` returns `null`.
      return row == null ? undefined : hydrate(state.table, row);
    },

    async all(): Promise<InferRow<T>[]> {
      const { sql: stmt, params } = renderSelect(state, {
        projection: "*",
        respectLimitOrder: true,
      });

      const rows = await sql.prepare(stmt).all(params);

      return rows.map((row) => hydrate(state.table, row));
    },

    async count(): Promise<number> {
      const { sql: stmt, params } = renderSelect(state, {
        projection: "COUNT(*) AS c",
        respectLimitOrder: false,
      });
      const row = (await sql.prepare(stmt).get(params)) as CountRow;

      // better-sqlite3 may hand back a bigint when safeIntegers is on;
      // coerce to number for the common single-table count.
      return Number(row.c);
    },
  };
}

function makeSelect(sql: SqlDatabase): SelectBuilder {
  return {
    from<T extends Table>(table: T): SelectQuery<T> {
      return makeQuery(sql, {
        table,
        where: undefined,
        orderBy: undefined,
        limit: undefined,
        offset: undefined,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

interface InsertReturning<T extends Table> {
  /** The single inserted row, hydrated. */
  get(): Promise<InferRow<T>>;
}

interface InsertValues<T extends Table> {
  /** Execute the insert; returns `{ changes }`. */
  run(): Promise<{ changes: number }>;

  /** Chain `.returning().get()` to receive the inserted row. */
  returning(): InsertReturning<T>;
}

interface InsertBuilder {
  <T extends Table>(
    table: T,
  ): {
    values(input: InferInsert<T>): InsertValues<T>;
  };
}

/** Compile an insert into (sql, params), using ONLY the keys the caller supplied. */
function compileInsert<T extends Table>(
  table: T,
  input: InferInsert<T>,
  returning: boolean,
): { sql: string; params: unknown[] } {
  const inputRecord = input as Record<string, unknown>;
  const supplied = Object.keys(inputRecord).filter((key) => key in table.byKey);

  if (supplied.length === 0) {
    throw new DbError(
      "DB_EMPTY_INSERT",
      `Insert into "${table.tableName}" supplied no columns. Pass at least one value, or rely on column defaults via an INSERT DEFAULT VALUES (not yet supported).`,
      { table: table.tableName },
    );
  }

  const columnNames = supplied.map((key) => quoteIdentifier(table.byKey[key]!.name)).join(", ");
  const placeholders = supplied.map(() => "?").join(", ");
  const params = supplied.map((key) => bind(inputRecord[key]));

  const sql = `INSERT INTO ${quoteIdentifier(table.tableName)} (${columnNames}) VALUES (${placeholders})${
    returning ? " RETURNING *" : ""
  }`;

  return { sql, params };
}

function makeInsert(sql: SqlDatabase): InsertBuilder {
  return function insert<T extends Table>(table: T) {
    return {
      values(input: InferInsert<T>): InsertValues<T> {
        return {
          async run() {
            const { sql: stmt, params } = compileInsert(table, input, false);
            const { changes } = await sql.prepare(stmt).run(params);

            return { changes };
          },
          returning() {
            return {
              async get(): Promise<InferRow<T>> {
                const { sql: stmt, params } = compileInsert(table, input, true);
                const row = await sql.prepare(stmt).get(params);

                return hydrate(table, row);
              },
            };
          },
        };
      },
    };
  };
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

interface UpdateSet {
  /** Add the `WHERE` clause — required, refusing an unbounded update. */
  where(condition: Condition): { run(): Promise<{ changes: number }> };
}

interface UpdateBuilder {
  <T extends Table>(
    table: T,
  ): {
    set(patch: InferUpdate<T>): UpdateSet;
  };
}

function makeUpdate(sql: SqlDatabase): UpdateBuilder {
  return function update<T extends Table>(table: T) {
    return {
      set(patch: InferUpdate<T>): UpdateSet {
        const patchRecord = patch as Record<string, unknown>;
        const supplied = Object.keys(patchRecord).filter((key) => key in table.byKey);

        if (supplied.length === 0) {
          throw new DbError(
            "DB_EMPTY_UPDATE",
            `Update on "${table.tableName}" supplied no columns to set.`,
            { table: table.tableName },
          );
        }

        const assignments = supplied
          .map((key) => `${quoteIdentifier(table.byKey[key]!.name)} = ?`)
          .join(", ");
        const setParams = supplied.map((key) => bind(patchRecord[key]));

        return {
          where(condition: Condition) {
            return {
              async run() {
                const stmt = `UPDATE ${quoteIdentifier(
                  table.tableName,
                )} SET ${assignments} WHERE ${condition.sql}`;
                const { changes } = await sql.prepare(stmt).run([...setParams, ...condition.params]);

                return { changes };
              },
            };
          },
        };
      },
    };
  };
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

interface DeleteBuilder {
  <T extends Table>(
    table: T,
  ): {
    /** Add the `WHERE` clause — required, refusing an unbounded delete. */
    where(condition: Condition): { run(): Promise<{ changes: number }> };
  };
}

function makeDelete(sql: SqlDatabase): DeleteBuilder {
  return function deleteFrom<T extends Table>(table: T) {
    return {
      where(condition: Condition) {
        return {
          async run() {
            const stmt = `DELETE FROM ${quoteIdentifier(table.tableName)} WHERE ${condition.sql}`;
            const { changes } = await sql.prepare(stmt).run([...condition.params]);

            return { changes };
          },
        };
      },
    };
  };
}

// ---------------------------------------------------------------------------
// createDb — the top-level entry the consumer holds
// ---------------------------------------------------------------------------

export interface Db {
  select(): SelectBuilder;
  insert: InsertBuilder;
  update: UpdateBuilder;
  delete: DeleteBuilder;

  /** Escape hatch: run arbitrary SQL the DSL does not cover. */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a single transaction (commit on resolve, rollback on
   * reject). `tx` is a {@link Db} bound to the transaction's connection, so
   * every query inside `fn` runs on the same connection — the only correct
   * shape on a pooled (Postgres) driver.
   */
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
}

/** Build a {@link Db} bound to the given driver handle. */
export function createDb(sql: SqlDatabase): Db {
  const select = makeSelect(sql);
  const insert = makeInsert(sql);
  const update = makeUpdate(sql);
  const deleteFrom = makeDelete(sql);

  return {
    select: () => select,
    insert,
    update,
    delete: deleteFrom,
    exec: async (statement) => {
      await sql.exec(statement);
    },
    transaction: (fn) => sql.transaction((txSql) => fn(createDb(txSql))),
  };
}
