/**
 * Typed column builders.
 *
 *   text("email").notNull().unique()
 *   integer("id").primaryKey({ autoIncrement: true })
 *   integer("score").default(0)
 *
 * Every builder produces a {@link Column} — a *value* that carries both its
 * runtime spec (used by DDL + the query compiler) and its phantom type (used
 * by `InferRow` / `InferInsert` / condition arity checks). Once `defineTable`
 * names them, the same value is the column reference (`users.email`) and the
 * authority on its type.
 *
 * **Why builders and not plain objects.** A builder makes the fluent API
 * (`text("x").notNull().unique()`) return a *new* `Column` with the modifier
 * flipped *in the type*, so the downstream inference picks up the change.
 * A plain-object DSL would force the user to spell the type twice (once in
 * the object, once at the call site); the builder pattern collapses that to
 * one source of truth.
 */

/** The underlying SQL type a column maps to. */
export type SqlType = "TEXT" | "INTEGER" | "REAL";

/**
 * The runtime spec for a column. Carries everything DDL needs to render the
 * column declaration, and everything the query compiler needs to bind values.
 */
export interface ColumnSpec {
  readonly name: string;
  readonly sqlType: SqlType;
  readonly nullable: boolean;
  readonly unique: boolean;
  readonly primaryKey: boolean;
  readonly autoIncrement: boolean;
  readonly hasDefault: boolean;
  readonly defaultValue?: string | number | boolean | null;
}

/**
 * A column reference: the value `defineTable` hands back as `users.email`.
 *
 * Generic parameters carry information that only matters at the type level:
 *
 *   - `T`            — the JS type of a non-null cell (`string`, `number`, ...).
 *   - `Nullable`     — whether the column may store `null`.
 *   - `HasDefault`   — whether the column has a default *or* is auto-assigned;
 *                       inserts treat such columns as optional.
 *
 * The runtime spec is the same shape regardless of the parameters — they
 * exist purely so that `eq(users.email, 1)` is a TypeScript error and
 * `db.insert(users).values({...})` knows which keys are optional.
 */
export interface Column<
  T = unknown,
  Nullable extends boolean = boolean,
  HasDefault extends boolean = boolean,
> {
  readonly spec: ColumnSpec;

  /** Phantom — never set at runtime, used only by `InferRow`/`InferInsert`. */
  readonly _type?: T;
  readonly _nullable?: Nullable;
  readonly _hasDefault?: HasDefault;
}

/** A column whose JS cell type is `T` — narrowed across the fluent chain. */
type ColumnOf<T> = Column<T, boolean, boolean>;

/**
 * The fluent column builder. Exported so a consumer's inferred schema type
 * (`typeof users`) can be named in another package without TS4023.
 *
 * Returned by `text()` / `integer()` / `real()`; every chainable method
 * (`.notNull()`, `.unique()`, etc.) returns a fresh builder with the
 * modifier flipped in the type.
 */
export interface ColumnBuilder<T, Nullable extends boolean, HasDefault extends boolean>
  extends Column<T, Nullable, HasDefault> {
  /** Mark the column `NOT NULL`. Default for new columns is *nullable*. */
  notNull(): ColumnBuilder<T, false, HasDefault>;

  /** Mark the column `UNIQUE`. */
  unique(): ColumnBuilder<T, Nullable, HasDefault>;

  /**
   * Mark the column the primary key. Sets `NOT NULL` (a primary key cannot be
   * null) and, when `autoIncrement` is on, marks it as having a default so
   * `InferInsert` treats it as optional.
   */
  primaryKey(options?: { autoIncrement?: boolean }): ColumnBuilder<T, false, true>;

  /** Stamp a default literal. The column is then optional on insert. */
  default(value: T): ColumnBuilder<T, Nullable, true>;
}

/** Compose a fresh builder around a (frozen) spec. */
function builder<T, N extends boolean, D extends boolean>(spec: ColumnSpec): ColumnBuilder<T, N, D> {
  const self: ColumnBuilder<T, N, D> = {
    spec,
    notNull: () => builder({ ...spec, nullable: false }),
    unique: () => builder({ ...spec, unique: true }),
    primaryKey: (options) =>
      builder({
        ...spec,
        primaryKey: true,
        nullable: false,
        autoIncrement: options?.autoIncrement === true,
        hasDefault: spec.hasDefault || options?.autoIncrement === true,
      }),
    default: (value) =>
      // The cast covers two cases at once: `value` is JS-side `T` (the column's
      // cell type), but `defaultValue` is stored as the SQL literal union the
      // DDL renderer accepts. Both shapes overlap in practice for the column
      // types we support (text/integer/real → string/number/boolean/null).
      builder({
        ...spec,
        hasDefault: true,
        defaultValue: value as string | number | boolean | null,
      }),
  };

  return self;
}

/** Seed a builder with the column's name and SQL type. New columns are nullable, non-unique, non-key. */
function seed<T>(name: string, sqlType: SqlType): ColumnBuilder<T, true, false> {
  return builder<T, true, false>({
    name,
    sqlType,
    nullable: true,
    unique: false,
    primaryKey: false,
    autoIncrement: false,
    hasDefault: false,
  });
}

/** A `TEXT` column — JS `string`. */
export function text(name: string): ColumnBuilder<string, true, false> {
  return seed<string>(name, "TEXT");
}

/** An `INTEGER` column — JS `number`. */
export function integer(name: string): ColumnBuilder<number, true, false> {
  return seed<number>(name, "INTEGER");
}

/** A `REAL` column — JS `number`. */
export function real(name: string): ColumnBuilder<number, true, false> {
  return seed<number>(name, "REAL");
}

/** Extract a column's JS cell type, accounting for nullability. */
export type CellType<C> =
  C extends Column<infer T, infer N> ? (N extends true ? T | null : T) : never;

/** True if a column is optional on insert (nullable, has a default, or auto-assigned). */
export type IsOptionalOnInsert<C> =
  C extends Column<unknown, infer N, infer D>
    ? N extends true
      ? true
      : D extends true
        ? true
        : false
    : false;

/** Re-export so `Column<string>` works without the second/third generic in consumer code. */
export type { ColumnOf };
