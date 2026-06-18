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
 * (`@volo/db`'s queries + DDL, downstream consumers like `@volo/identity`)
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

interface TableMeta {
  /** The SQL table name. Always the un-quoted identifier. */
  readonly tableName: string;

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
export type Table<C extends ColumnMap = ColumnMap> = C & TableMeta;

/**
 * Define a table by handing a column map to {@link defineTable}.
 *
 * The columns must be the *builders*, not their specs — the builder type
 * carries the per-column nullability and default state into the inferred
 * row/insert types. The strict `Record<string, Column>` constraint is on
 * the parameter so the call site is type-checked, while `Table<C>`'s
 * generic stays loose enough to intersect with `TableMeta`.
 */
export function defineTable<C extends Record<string, Column<unknown, boolean, boolean>>>(
  tableName: string,
  columns: C,
): Table<C> {
  const columnList: Column<unknown, boolean, boolean>[] = [];
  const byKey: Record<string, ColumnSpec> = {};
  const byColumn: Record<string, string> = {};

  for (const [key, column] of Object.entries(columns)) {
    columnList.push(column);
    byKey[key] = column.spec;
    byColumn[column.spec.name] = key;
  }

  return Object.assign({}, columns, {
    tableName,
    columnList,
    byKey,
    byColumn,
  });
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
