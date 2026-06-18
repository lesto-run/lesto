/**
 * Typed condition builders for `WHERE`.
 *
 *   eq(users.email, "ada@example.com")          // typed: arg 2 must be string
 *   ne(users.id, 1)
 *   and(eq(users.email, e), isNotNull(users.emailVerifiedAt))
 *   or(eq(users.id, 1), eq(users.id, 2))
 *   isNull(users.emailVerifiedAt)
 *
 * A {@link Condition} is a small AST: a `sql` fragment with `?` placeholders
 * plus the `params` array in order. The query compiler concatenates the
 * fragment after `WHERE` and threads the params straight to `prepare(...)`.
 * No string-interpolated values; SQL injection is structurally impossible.
 */

import type { CellType, Column } from "./columns";
import { quoteIdentifier } from "./identifier";
import { bind } from "./values";

/** A compiled condition — what the query compiler appends after `WHERE`. */
export interface Condition {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** `column = value` — the workhorse condition. */
export function eq<C extends Column<unknown, boolean, boolean>>(
  column: C,
  value: NonNullable<CellType<C>>,
): Condition {
  return {
    sql: `${quoteIdentifier(column.spec.name)} = ?`,
    params: [bind(value)],
  };
}

/** `column <> value` — the inverse of {@link eq}. */
export function ne<C extends Column<unknown, boolean, boolean>>(
  column: C,
  value: NonNullable<CellType<C>>,
): Condition {
  return {
    sql: `${quoteIdentifier(column.spec.name)} <> ?`,
    params: [bind(value)],
  };
}

/** `column > value`. */
export function gt<C extends Column<unknown, boolean, boolean>>(
  column: C,
  value: NonNullable<CellType<C>>,
): Condition {
  return {
    sql: `${quoteIdentifier(column.spec.name)} > ?`,
    params: [bind(value)],
  };
}

/** `column >= value`. */
export function gte<C extends Column<unknown, boolean, boolean>>(
  column: C,
  value: NonNullable<CellType<C>>,
): Condition {
  return {
    sql: `${quoteIdentifier(column.spec.name)} >= ?`,
    params: [bind(value)],
  };
}

/** `column < value`. */
export function lt<C extends Column<unknown, boolean, boolean>>(
  column: C,
  value: NonNullable<CellType<C>>,
): Condition {
  return {
    sql: `${quoteIdentifier(column.spec.name)} < ?`,
    params: [bind(value)],
  };
}

/** `column <= value`. */
export function lte<C extends Column<unknown, boolean, boolean>>(
  column: C,
  value: NonNullable<CellType<C>>,
): Condition {
  return {
    sql: `${quoteIdentifier(column.spec.name)} <= ?`,
    params: [bind(value)],
  };
}

/**
 * `column IN (?, ?, …)` — membership against a list of values.
 *
 * An EMPTY list is the empty set: nothing can be a member, so this renders the
 * always-false `1 = 0` (with no params) rather than the syntactically invalid
 * `IN ()`. `column IN (a)` and `column = a` are equivalent; we keep the `IN`
 * form for one stable shape regardless of length.
 */
export function inList<C extends Column<unknown, boolean, boolean>>(
  column: C,
  values: readonly NonNullable<CellType<C>>[],
): Condition {
  if (values.length === 0) {
    return { sql: "1 = 0", params: [] };
  }

  const placeholders = values.map(() => "?").join(", ");

  return {
    sql: `${quoteIdentifier(column.spec.name)} IN (${placeholders})`,
    params: values.map((value) => bind(value)),
  };
}

/**
 * `column LIKE pattern` — SQL pattern match on a text column (`%` = any run,
 * `_` = any single char). The pattern is a bound parameter, so `%` / `_` in the
 * caller's string are SQL wildcards but the value is never interpolated. Typed to
 * text columns only — `LIKE` on a number is almost always a mistake.
 */
export function like<C extends Column<string, boolean, boolean>>(
  column: C,
  pattern: string,
): Condition {
  return {
    sql: `${quoteIdentifier(column.spec.name)} LIKE ?`,
    params: [pattern],
  };
}

/** `column IS NULL`. Defined separately because SQL `= NULL` does not match. */
export function isNull(column: Column<unknown, boolean, boolean>): Condition {
  return {
    sql: `${quoteIdentifier(column.spec.name)} IS NULL`,
    params: [],
  };
}

/** `column IS NOT NULL`. */
export function isNotNull(column: Column<unknown, boolean, boolean>): Condition {
  return {
    sql: `${quoteIdentifier(column.spec.name)} IS NOT NULL`,
    params: [],
  };
}

/** Combine conditions with `AND`. Single-arg returns the arg unchanged. */
export function and(...conditions: Condition[]): Condition {
  return combine("AND", conditions);
}

/** Combine conditions with `OR`. Single-arg returns the arg unchanged. */
export function or(...conditions: Condition[]): Condition {
  return combine("OR", conditions);
}

function combine(joiner: "AND" | "OR", conditions: Condition[]): Condition {
  // A single combined condition is just itself — avoid `( x )` noise in SQL.
  if (conditions.length === 1) return conditions[0]!;

  return {
    sql: conditions.map((c) => `(${c.sql})`).join(` ${joiner} `),
    params: conditions.flatMap((c) => c.params),
  };
}
