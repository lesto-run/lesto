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
 *
 * An optional {@link DbOptions.onQuery} sink observes every executed query (sql +
 * measured `durationMs`) for tracing; with no sink the driver handle flows through
 * untouched and there is zero measurement cost.
 */

import type { Column, ColumnKind } from "./columns";
import type { Condition } from "./conditions";
import type { Dialect } from "./ddl";
import { DbError } from "./errors";
import { quoteIdentifier } from "./identifier";
import type { SqlDatabase } from "./sql";
import type { InferInsert, InferRow, InferUpdate, Table } from "./table";

/** Coerce a JS value to the form the SQL driver expects. */
function bind(value: unknown): unknown {
  if (value === undefined) return null;

  if (typeof value === "boolean") return value ? 1 : 0;

  // A `timestamp` column's JS value is a `Date`; it stores as its epoch-ms
  // integer (the same number `hydrate` reads back). Drivers reject a Date object.
  if (value instanceof Date) return value.getTime();

  return value;
}

/**
 * Coerce one raw cell to its `InferRow` JS type, dispatched on the column's
 * logical {@link ColumnKind}.
 *
 * Driver-agnostic by construction: node-postgres hands an `INTEGER`/`BIGINT`-backed
 * column back as a *string* while SQLite returns a number, so every numeric-storage
 * kind runs through `Number(...)` — one branch-free path identical on both engines.
 * That is what makes `InferRow` honest across drivers (and lets `createTableSql`
 * widen `INTEGER`→`BIGINT` on Postgres without leaking a string to the caller).
 *
 *   - `boolean`   — `0/1` (or `"0"/"1"`) → `false/true`
 *   - `timestamp` — epoch-ms (number or string) → `Date`
 *   - `integer`/`real` — → `number`
 *   - `text` / unknown column — passed through untouched (a numeric-looking string
 *     in a `TEXT` column stays a string)
 *
 * `null` always stays `null` (a nullable boolean/timestamp does not become
 * `false`/`Invalid Date`).
 */
function coerceCell(kind: ColumnKind | undefined, value: unknown): unknown {
  if (value === null) return null;

  switch (kind) {
    case "boolean":
      return Number(value) === 1;
    case "timestamp":
      return new Date(Number(value));
    case "integer":
    case "real":
      return Number(value);
    default:
      return value;
  }
}

/**
 * Hydrate a raw row (snake_case keys) into the camelCase row the consumer
 * expects, using the table's `byColumn` map. Unknown columns are passed through
 * (defensive — a future column added in DDL would otherwise drop), with their
 * value untouched since the table has no `kind` for them.
 */
function hydrate<T extends Table>(table: T, raw: unknown): InferRow<T> {
  const row = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [columnName, value] of Object.entries(row)) {
    const key = table.byColumn[columnName] ?? columnName;
    out[key] = coerceCell(table.byKey[key]?.kind, value);
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
  options: { projection: string; respectLimitOrder: boolean; dialect: Dialect },
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
    // caller asked for offset alone we still need a "no row cap" limit so the
    // offset applies: SQLite spells that `LIMIT -1`, which Postgres rejects —
    // Postgres takes a bare `OFFSET` (or the equivalent `LIMIT ALL`). This is
    // the second dialect fork, decided here at render time from `dialect`.
    if (state.limit !== undefined) {
      parts.push(`LIMIT ${state.limit}`);
      if (state.offset !== undefined) parts.push(`OFFSET ${state.offset}`);
    } else if (state.offset !== undefined) {
      parts.push(
        options.dialect === "postgres"
          ? `OFFSET ${state.offset}`
          : `LIMIT -1 OFFSET ${state.offset}`,
      );
    }
  }

  return { sql: parts.join(" "), params };
}

interface CountRow {
  readonly c: number | bigint;
}

function makeQuery<T extends Table>(
  sql: SqlDatabase,
  dialect: Dialect,
  state: SelectState<T>,
): SelectQuery<T> {
  const next = (patch: Partial<SelectState<T>>): SelectQuery<T> =>
    makeQuery(sql, dialect, { ...state, ...patch });

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
        { projection: "*", respectLimitOrder: true, dialect },
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
        dialect,
      });

      const rows = await sql.prepare(stmt).all(params);

      return rows.map((row) => hydrate(state.table, row));
    },

    async count(): Promise<number> {
      const { sql: stmt, params } = renderSelect(state, {
        projection: "COUNT(*) AS c",
        respectLimitOrder: false,
        dialect,
      });
      const row = (await sql.prepare(stmt).get(params)) as CountRow;

      // better-sqlite3 may hand back a bigint when safeIntegers is on;
      // coerce to number for the common single-table count.
      return Number(row.c);
    },
  };
}

function makeSelect(sql: SqlDatabase, dialect: Dialect): SelectBuilder {
  return {
    from<T extends Table>(table: T): SelectQuery<T> {
      return makeQuery(sql, dialect, {
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
                const { changes } = await sql
                  .prepare(stmt)
                  .run([...setParams, ...condition.params]);

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

  /**
   * DDL-only escape hatch: run a statement the DSL does not model, for its side
   * effect, with NO parameters (`CREATE TABLE`, `CREATE INDEX`, `DROP …`). The
   * string is sent verbatim, so it must NOT carry user input — for a
   * value-bearing query use {@link Db.raw}, which binds parameters and returns
   * rows.
   */
  exec(sql: string): Promise<void>;

  /**
   * Parameterized escape hatch: run arbitrary SQL the DSL does not model, with
   * `?` placeholders bound to `params`, and read the result rows back.
   *
   * Unlike {@link Db.exec}, every value rides a `?` placeholder (the driver
   * translates `?` → `$n` on Postgres), so user input is safe — this is the
   * escape hatch to reach for when a query needs a value, not `exec`. Rows come
   * back raw (driver column names, driver types — no snake→camel hydration and
   * no numeric coercion, since `raw` has no schema to map against). `R` is the
   * caller's asserted row shape.
   *
   * `raw` is for ROW-RETURNING statements (a `SELECT`, or a write with
   * `RETURNING`): it reads the result set back. For a non-returning write, use
   * {@link Db.exec} — on SQLite (better-sqlite3) running a non-returning write
   * through `raw` THROWS, because the underlying `.all()` rejects a statement
   * that produces no rows.
   */
  raw<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]>;

  /**
   * Run `fn` inside a single transaction (commit on resolve, rollback on
   * reject). `tx` is a {@link Db} bound to the transaction's connection, so
   * every query inside `fn` runs on the same connection — the only correct
   * shape on a pooled (Postgres) driver.
   */
  transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
}

/** A single executed query, reported to {@link DbOptions.onQuery}. */
export interface QueryEvent {
  /** The SQL text sent to the driver (identifiers only — every value rode a `?`). */
  readonly sql: string;

  /** Wall-clock duration of the driver round-trip, in milliseconds (fractional). */
  readonly durationMs: number;
}

/** Options for {@link createDb}. */
export interface DbOptions {
  /**
   * Which SQL dialect to render for. Defaults to `"sqlite"`. The only query the
   * dialect changes is offset-without-limit (SQLite needs `LIMIT -1`, Postgres
   * takes a bare `OFFSET`); every other statement is identical. A `tx` opened by
   * {@link Db.transaction} inherits its parent's dialect.
   */
  readonly dialect?: Dialect;

  /**
   * Observability seam: invoked once per *executed* query with the SQL text and a
   * measured `durationMs`. Fires for every `get`/`all`/`run` a statement runs —
   * the select/insert/update/delete terminals AND the {@link Db.raw} escape hatch
   * (`exec` runs no statement and never reports). Default `undefined` = zero
   * behaviour change and zero measurement cost.
   *
   * The hook NEVER changes the query's result or its timing the caller observes:
   * it runs after the driver resolves and its own throw is swallowed, so a broken
   * sink can never break a query. A `tx` opened by {@link Db.transaction} inherits
   * the same sink, so spans inside a transaction report too.
   */
  readonly onQuery?: (event: QueryEvent) => void;
}

/**
 * Wrap a driver handle so each prepared statement reports its executed
 * `get`/`all`/`run` to `onQuery`. The measurement brackets ONLY the driver call;
 * the sink runs after the result resolves and its throw is contained, so neither
 * the result nor the latency the caller sees is touched. `prepare` is sync (it
 * compiles, it does not touch the wire), so it is forwarded untimed; `exec` and
 * `transaction` pass through (a `tx`'s own `prepare` is re-wrapped one level down
 * by the nested {@link createDb}).
 */
function instrument(sql: SqlDatabase, onQuery: (event: QueryEvent) => void): SqlDatabase {
  // Time, run the terminal, then report — never letting a broken sink leak out.
  const timed = async <T>(statement: string, run: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    const result = await run();
    const durationMs = performance.now() - start;

    try {
      onQuery({ sql: statement, durationMs });
    } catch {
      // A throwing observability sink must never break the query it observed.
    }

    return result;
  };

  return {
    exec: (statement) => sql.exec(statement),

    prepare: (statement) => {
      const stmt = sql.prepare(statement);

      return {
        run: (params) => timed(statement, () => stmt.run(params)),
        get: (params) => timed(statement, () => stmt.get(params)),
        all: (params) => timed(statement, () => stmt.all(params)),
      };
    },

    transaction: (fn) => sql.transaction(fn),
  };
}

/** Build a {@link Db} bound to the given driver handle. */
export function createDb(sql: SqlDatabase, options: DbOptions = {}): Db {
  const dialect = options.dialect ?? "sqlite";
  const onQuery = options.onQuery;

  // Instrument the handle once, here, so every terminal AND `raw` reports through
  // one seam. With no sink the original handle flows through untouched.
  const handle = onQuery ? instrument(sql, onQuery) : sql;

  const select = makeSelect(handle, dialect);
  const insert = makeInsert(handle);
  const update = makeUpdate(handle);
  const deleteFrom = makeDelete(handle);

  return {
    select: () => select,
    insert,
    update,
    delete: deleteFrom,
    exec: async (statement) => {
      await handle.exec(statement);
    },
    raw: async <R = Record<string, unknown>>(statement: string, params: readonly unknown[] = []) =>
      (await handle.prepare(statement).all([...params])) as R[],
    transaction: (fn) =>
      // A `tx` inherits both the dialect and the sink: re-wrapping inside the
      // nested createDb instruments the transaction's own connection handle.
      handle.transaction((txSql) =>
        fn(createDb(txSql, onQuery ? { dialect, onQuery } : { dialect })),
      ),
  };
}
