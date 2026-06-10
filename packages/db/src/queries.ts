/**
 * The four query verbs — `select`, `insert`, `update`, `delete` — built on
 * the schema-as-value.
 *
 *   const user = db.select().from(users).where(eq(users.email, e)).get();
 *   db.insert(users).values({ email, passwordHash, ... }).returning().get();
 *   db.update(users).set({ passwordHash }).where(eq(users.id, 1)).run();
 *   db.delete(users).where(eq(users.id, 1)).run();
 *
 * Each verb is a fluent chain that *terminates* in a driver call:
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
// ---------------------------------------------------------------------------

interface SelectFrom<T extends Table> {
  /** Add a `WHERE` clause. Chainable. */
  where(condition: Condition): SelectWhere<T>;

  /** First row, or `undefined`. */
  get(): InferRow<T> | undefined;

  /** Every row. */
  all(): InferRow<T>[];
}

interface SelectWhere<T extends Table> {
  get(): InferRow<T> | undefined;
  all(): InferRow<T>[];
}

interface SelectBuilder {
  from<T extends Table>(table: T): SelectFrom<T>;
}

function makeSelect(sql: SqlDatabase): SelectBuilder {
  return {
    from<T extends Table>(table: T): SelectFrom<T> {
      const base = `SELECT * FROM ${quoteIdentifier(table.tableName)}`;

      const run = (condition: Condition | undefined, limit: number | undefined): InferRow<T>[] => {
        const parts = [base];
        const params: unknown[] = [];

        if (condition) {
          parts.push(`WHERE ${condition.sql}`);
          params.push(...condition.params);
        }

        if (limit !== undefined) parts.push(`LIMIT ${limit}`);

        const rows = sql.prepare(parts.join(" ")).all(params);

        return rows.map((row) => hydrate(table, row));
      };

      const get = (condition: Condition | undefined): InferRow<T> | undefined =>
        run(condition, 1)[0];

      return {
        where: (condition) => ({
          get: () => get(condition),
          all: () => run(condition, undefined),
        }),
        get: () => get(undefined),
        all: () => run(undefined, undefined),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

interface InsertReturning<T extends Table> {
  /** The single inserted row, hydrated. */
  get(): InferRow<T>;
}

interface InsertValues<T extends Table> {
  /** Execute the insert; returns `{ changes }`. */
  run(): { changes: number };

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
          run() {
            const { sql: stmt, params } = compileInsert(table, input, false);
            const { changes } = sql.prepare(stmt).run(params);

            return { changes };
          },
          returning() {
            return {
              get(): InferRow<T> {
                const { sql: stmt, params } = compileInsert(table, input, true);
                const row = sql.prepare(stmt).get(params);

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
  where(condition: Condition): { run(): { changes: number } };
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
              run() {
                const stmt = `UPDATE ${quoteIdentifier(
                  table.tableName,
                )} SET ${assignments} WHERE ${condition.sql}`;
                const { changes } = sql.prepare(stmt).run([...setParams, ...condition.params]);

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
    where(condition: Condition): { run(): { changes: number } };
  };
}

function makeDelete(sql: SqlDatabase): DeleteBuilder {
  return function deleteFrom<T extends Table>(table: T) {
    return {
      where(condition: Condition) {
        return {
          run() {
            const stmt = `DELETE FROM ${quoteIdentifier(table.tableName)} WHERE ${condition.sql}`;
            const { changes } = sql.prepare(stmt).run([...condition.params]);

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
  exec(sql: string): void;
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
    exec: (statement) => {
      sql.exec(statement);
    },
  };
}
