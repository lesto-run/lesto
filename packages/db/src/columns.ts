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

/** The underlying SQL storage type a column maps to. */
export type SqlType = "TEXT" | "INTEGER" | "REAL";

/**
 * The *logical* kind of a column — what the value means, as opposed to how it is
 * stored ({@link SqlType}). The two diverge for `boolean` and `timestamp`, which
 * both store as `INTEGER` (a `0/1` flag, an epoch-ms instant) but hydrate to a JS
 * `boolean` / `Date`. The query layer dispatches on `kind` to coerce a raw cell to
 * its `InferRow` type; DDL renders the storage `sqlType`. (ADR 0018, Increment 1.)
 */
export type ColumnKind = "text" | "integer" | "real" | "boolean" | "timestamp";

/** The storage type each logical kind lands in. */
const STORAGE: Record<ColumnKind, SqlType> = {
  text: "TEXT",
  integer: "INTEGER",
  real: "REAL",
  boolean: "INTEGER",
  timestamp: "INTEGER",
};

/**
 * What a foreign key does to the child row when its parent changes. ANSI-standard
 * and spelled identically on SQLite and Postgres, so the DDL never forks.
 * (`set null` requires a nullable column — the DB enforces that at delete time.)
 */
export type ReferentialAction = "cascade" | "restrict" | "set null" | "no action";

/** A foreign key declared on a column via `.references()`. */
export interface ColumnReference {
  /**
   * Resolves the target column. A *thunk* (not the column itself) so two tables can
   * reference each other across a circular import; it is called once at DDL-render
   * time, by when every `defineTable` has sealed and the target carries its
   * `tableName` (ADR 0018, Increment 0).
   */
  readonly resolve: () => Column;
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
}

/**
 * The runtime spec for a column. Carries everything DDL needs to render the
 * column declaration, and everything the query compiler needs to bind values.
 */
export interface ColumnSpec {
  readonly name: string;
  readonly kind: ColumnKind;
  readonly sqlType: SqlType;
  readonly nullable: boolean;
  readonly unique: boolean;
  readonly primaryKey: boolean;
  readonly autoIncrement: boolean;
  readonly hasDefault: boolean;
  readonly defaultValue?: string | number | boolean | null;

  /**
   * The owning table's name, stamped by `defineTable`. Absent on a free-standing
   * builder (`text("x").spec.tableName === undefined`); present once the column
   * is placed in a table (`users.email.spec.tableName === "users"`). Foreign-key
   * DDL and table-qualified join rendering (ADR 0018) read the owning table from
   * here, so a column reference is self-describing.
   */
  readonly tableName?: string;

  /** The foreign key declared on this column, if any (`.references(...)`). */
  readonly references?: ColumnReference;
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
export interface ColumnBuilder<
  T,
  Nullable extends boolean,
  HasDefault extends boolean,
> extends Column<T, Nullable, HasDefault> {
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

  /**
   * Declare a foreign key to another column. The target is a thunk (`() =>
   * users.id`) so two tables can reference each other across imports. Its column
   * type must match this one's — `references(() => users.id)` on a `text` column is
   * a compile error — which is the anti-ORM win: a wrong reference fails at compile
   * time, not as a pluralized string at runtime (ADR 0018 §2).
   *
   * A *self*-reference (a table pointing at its own column) needs the thunk's
   * return type annotated to break TypeScript's circular inference —
   * `references((): Column<number> => employees.id)` — the same one-line ceremony
   * Drizzle requires. Cross-table references need no annotation.
   */
  references(
    target: () => Column<T, boolean, boolean>,
    options?: { onDelete?: ReferentialAction; onUpdate?: ReferentialAction },
  ): ColumnBuilder<T, Nullable, HasDefault>;
}

/** Compose a fresh builder around a (frozen) spec. */
function builder<T, N extends boolean, D extends boolean>(
  spec: ColumnSpec,
): ColumnBuilder<T, N, D> {
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
      // `defaultValue` is the SQL literal the DDL renderer accepts. A `Date`
      // (a `timestamp` column's `T`) is stored as its epoch-ms integer — the same
      // shape `bind` writes — so the rendered `DEFAULT` is a valid integer literal,
      // not a `String(date)`. The cast covers the remaining text/integer/real/
      // boolean cases, whose `T` already overlaps the literal union.
      builder({
        ...spec,
        hasDefault: true,
        defaultValue:
          value instanceof Date ? value.getTime() : (value as string | number | boolean | null),
      }),
    references: (target, options) =>
      builder({ ...spec, references: { resolve: target, ...options } }),
  };

  return self;
}

/** Seed a builder from the column's name + logical kind. New columns are nullable, non-unique, non-key. */
function seed<T>(name: string, kind: ColumnKind): ColumnBuilder<T, true, false> {
  return builder<T, true, false>({
    name,
    kind,
    sqlType: STORAGE[kind],
    nullable: true,
    unique: false,
    primaryKey: false,
    autoIncrement: false,
    hasDefault: false,
  });
}

/** A `TEXT` column — JS `string`. */
export function text(name: string): ColumnBuilder<string, true, false> {
  return seed<string>(name, "text");
}

/** An `INTEGER` column — JS `number`. */
export function integer(name: string): ColumnBuilder<number, true, false> {
  return seed<number>(name, "integer");
}

/** A `REAL` column — JS `number`. */
export function real(name: string): ColumnBuilder<number, true, false> {
  return seed<number>(name, "real");
}

/** A `boolean` column — stored as `INTEGER` `0/1`, read back as a JS `boolean`. */
export function boolean(name: string): ColumnBuilder<boolean, true, false> {
  return seed<boolean>(name, "boolean");
}

/** A `timestamp` column — stored as epoch-ms `INTEGER`, read back as a JS `Date`. */
export function timestamp(name: string): ColumnBuilder<Date, true, false> {
  return seed<Date>(name, "timestamp");
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
