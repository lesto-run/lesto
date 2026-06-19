/**
 * `defineTable` — the schema-as-value entry point.
 *
 *   export const users = defineTable("users", {
 *     id: integer("id").primaryKey({ autoIncrement: true }),
 *     email: text("email").notNull().unique(),
 *     passwordHash: text("password_hash").notNull(),
 *     emailVerifiedAt: text("email_verified_at"),
 *   });
 *
 *   type User = InferRow<typeof users>;
 *   //   { id: number; email: string; passwordHash: string; emailVerifiedAt: string | null }
 *
 *   type NewUser = InferInsert<typeof users>;
 *   //   { email: string; passwordHash: string; emailVerifiedAt?: string | null; id?: number }
 *
 * The `users` value is *also* the column-reference table — `users.email` is
 * the typed column the query layer binds against. Every other module
 * (`@lesto/db`'s queries + DDL, downstream consumers like `@lesto/identity`)
 * imports this one value and reads everything from it.
 */

import type { CellType, Column, ColumnSpec, IsOptionalOnInsert } from "./columns";

/**
 * A loose constraint for the table-generic — any object shape.
 *
 * `defineTable`'s *parameter* enforces "values must be Columns"; the table
 * type itself doesn't, so that `Table<C> = C & TableMeta` can intersect
 * cleanly without colliding with a `Record<string, Column>` index signature
 * (the strict version of which would refuse `tableName: string` on the
 * RHS of the `&`).
 */
export type ColumnMap = object;

interface TableMeta<N extends string = string> {
  /**
   * The SQL table name — OR, for an {@link alias}, the alias. Captured as a literal
   * `N` so a join can namespace its result rows by it (`{ users: …, posts: … }`).
   */
  readonly tableName: N;

  /**
   * The real table an {@link alias} stands for, so a join renders `FROM "real" AS
   * "alias"`. Absent on a normal table (then `tableName` IS the real name).
   */
  readonly sourceTableName?: string;

  /** Every column, in declaration order — what DDL renders and SELECT enumerates. */
  readonly columnList: readonly Column<unknown, boolean, boolean>[];

  /** Map: JS key (camelCase) → ColumnSpec. The single place the mapping lives. */
  readonly byKey: Readonly<Record<string, ColumnSpec>>;

  /** Map: SQL column name (snake_case) → JS key. Used hydrating SELECT rows. */
  readonly byColumn: Readonly<Record<string, string>>;
}

/**
 * A defined table — name + columns, plus the camelCase ↔ snake_case maps the
 * row hydrator needs.
 *
 * Generic in `C` (the column map) so `InferRow<typeof users>` recovers the
 * exact per-column types. The table value extends the column map *directly*,
 * so `users.email` is the column reference (no `users.columns.email`
 * ceremony).
 */
export type Table<C extends ColumnMap = ColumnMap, N extends string = string> = C & TableMeta<N>;

/**
 * Define a table by handing a column map to {@link defineTable}.
 *
 * The columns must be the *builders*, not their specs — the builder type
 * carries the per-column nullability and default state into the inferred
 * row/insert types. The strict `Record<string, Column>` constraint is on
 * the parameter so the call site is type-checked, while `Table<C>`'s
 * generic stays loose enough to intersect with `TableMeta`.
 */
export function defineTable<
  const N extends string,
  C extends Record<string, Column<unknown, boolean, boolean>>,
>(tableName: N, columns: C): Table<C, N> {
  const columnList: Column<unknown, boolean, boolean>[] = [];
  const byKey: Record<string, ColumnSpec> = {};
  const byColumn: Record<string, string> = {};

  // A fresh object: spreading `columns` preserves the precise `C` type (so the
  // return needs no cast). The loop then replaces each column with a copy whose
  // spec carries the owning table (ADR 0018 §0) — written onto `table`, never the
  // caller's builders, so two tables can't poison a shared column's identity.
  const table = Object.assign({}, columns, { tableName, columnList, byKey, byColumn });

  for (const [key, column] of Object.entries(columns)) {
    // The copy keeps the builder's phantom type; only the spec is replaced.
    // Chaining a modifier off a *placed* column (`users.email.notNull()`) is
    // nonsensical, so the original spec its methods close over is never observed.
    const withTable: Column<unknown, boolean, boolean> = {
      ...column,
      spec: { ...column.spec, tableName },
    };
    (table as Record<string, unknown>)[key] = withTable;
    columnList.push(withTable);
    byKey[key] = withTable.spec;
    byColumn[withTable.spec.name] = key;
  }

  return table;
}

/**
 * A second handle on a table under a different name — required to join a table to
 * itself (`employees` as both `employee` and `manager`). Every column re-qualifies
 * by the alias (so `eq(manager.id, …)` renders `"manager"."id"`), and the original
 * name is kept so a join renders `FROM "employees" AS "manager"` (ADR 0018 §3).
 */
export function alias<C extends ColumnMap, const N extends string>(
  table: Table<C>,
  name: N,
): Table<C, N> {
  const columnList: Column<unknown, boolean, boolean>[] = [];
  const byKey: Record<string, ColumnSpec> = {};
  const byColumn: Record<string, string> = {};

  const aliased = Object.assign({}, table, {
    tableName: name,
    // Resolve to the REAL table, even when aliasing an alias — otherwise a
    // double-alias would render `FROM "<inner-alias>" AS "<outer>"`, a table that
    // does not exist.
    sourceTableName: table.sourceTableName ?? table.tableName,
    columnList,
    byKey,
    byColumn,
  });

  for (const key of Object.keys(table.byKey)) {
    const original = (table as Record<string, unknown>)[key] as Column<unknown, boolean, boolean>;
    const withAlias: Column<unknown, boolean, boolean> = {
      ...original,
      spec: { ...original.spec, tableName: name },
    };
    (aliased as Record<string, unknown>)[key] = withAlias;
    columnList.push(withAlias);
    byKey[key] = withAlias.spec;
    byColumn[withAlias.spec.name] = key;
  }

  return aliased;
}

/** The row shape SELECT produces — every column with nullability folded in. */
export type InferRow<T extends Table> = {
  [K in keyof T as T[K] extends Column<unknown, boolean, boolean> ? K : never]: T[K] extends Column<
    unknown,
    boolean,
    boolean
  >
    ? CellType<T[K]>
    : never;
};

/**
 * The shape INSERT accepts — like `InferRow`, but nullable / defaulted /
 * auto-assigned columns are optional. A required-and-no-default column must
 * be supplied; everything else may be omitted.
 */
export type InferInsert<T extends Table> = {
  // Required keys.
  [K in keyof T as T[K] extends Column<unknown, boolean, boolean>
    ? IsOptionalOnInsert<T[K]> extends true
      ? never
      : K
    : never]: T[K] extends Column<unknown, boolean, boolean> ? CellType<T[K]> : never;
} & {
  // Optional keys.
  [K in keyof T as T[K] extends Column<unknown, boolean, boolean>
    ? IsOptionalOnInsert<T[K]> extends true
      ? K
      : never
    : never]?: T[K] extends Column<unknown, boolean, boolean> ? CellType<T[K]> : never;
};

/** The shape UPDATE's `.set(...)` accepts — every column optional, no auto fields. */
export type InferUpdate<T extends Table> = {
  [K in keyof T as T[K] extends Column<unknown, boolean, boolean>
    ? K
    : never]?: T[K] extends Column<unknown, boolean, boolean> ? CellType<T[K]> : never;
};
