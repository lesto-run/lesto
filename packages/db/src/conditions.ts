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

/**
 * Render a column as a table-qualified identifier — `"users"."email"`. Qualifying
 * every condition (not only a join's `ON`) keeps one rendering rule and makes a
 * column reference unambiguous the moment a query touches more than one table
 * (ADR 0018 §3). It is valid, identical-semantics SQL for a single-table query too.
 * `tableName` is stamped by `defineTable` (Increment 0); a free-standing column that
 * was never placed in a table has none, and falls back to a bare identifier.
 */
export function qualified(column: Column<unknown, boolean, boolean>): string {
  const { tableName, name } = column.spec;

  return tableName === undefined
    ? quoteIdentifier(name)
    : `${quoteIdentifier(tableName)}.${quoteIdentifier(name)}`;
}

/**
 * `column = value` — the workhorse condition — OR `column = otherColumn`, the form a
 * join's `ON` needs (`eq(posts.authorId, authors.id)`). A column on the right renders
 * `"a"."x" = "b"."y"` with no bound value; anything else is compared on a `?`
 * placeholder. The right column's type must match the left's.
 */
export function eq<C extends Column<unknown, boolean, boolean>>(
  column: C,
  value: NonNullable<CellType<C>> | Column<NonNullable<CellType<C>>, boolean, boolean>,
): Condition {
  // A column carries a `spec`; no value type does — `Date`, arrays, and the scalars
  // all lack it. A `null` forced past the `NonNullable` signature (only reachable via
  // `as any`) throws here on `"spec" in null` — the right loud failure for a contract
  // violation; `isNull(column)` is the real `IS NULL` test. (Revisit if a `json` value
  // can ever carry a `spec` key — it would have to brand columns instead.)
  if (typeof value === "object" && "spec" in value) {
    return { sql: `${qualified(column)} = ${qualified(value)}`, params: [] };
  }

  return {
    sql: `${qualified(column)} = ?`,
    params: [bind(value)],
  };
}

/** `column <> value` — the inverse of {@link eq}. */
export function ne<C extends Column<unknown, boolean, boolean>>(
  column: C,
  value: NonNullable<CellType<C>>,
): Condition {
  return {
    sql: `${qualified(column)} <> ?`,
    params: [bind(value)],
  };
}

/** `column > value`. */
export function gt<C extends Column<unknown, boolean, boolean>>(
  column: C,
  value: NonNullable<CellType<C>>,
): Condition {
  return {
    sql: `${qualified(column)} > ?`,
    params: [bind(value)],
  };
}

/** `column >= value`. */
export function gte<C extends Column<unknown, boolean, boolean>>(
  column: C,
  value: NonNullable<CellType<C>>,
): Condition {
  return {
    sql: `${qualified(column)} >= ?`,
    params: [bind(value)],
  };
}

/** `column < value`. */
export function lt<C extends Column<unknown, boolean, boolean>>(
  column: C,
  value: NonNullable<CellType<C>>,
): Condition {
  return {
    sql: `${qualified(column)} < ?`,
    params: [bind(value)],
  };
}

/** `column <= value`. */
export function lte<C extends Column<unknown, boolean, boolean>>(
  column: C,
  value: NonNullable<CellType<C>>,
): Condition {
  return {
    sql: `${qualified(column)} <= ?`,
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
    sql: `${qualified(column)} IN (${placeholders})`,
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
    sql: `${qualified(column)} LIKE ?`,
    params: [pattern],
  };
}

/** `column IS NULL`. Defined separately because SQL `= NULL` does not match. */
export function isNull(column: Column<unknown, boolean, boolean>): Condition {
  return {
    sql: `${qualified(column)} IS NULL`,
    params: [],
  };
}

/** `column IS NOT NULL`. */
export function isNotNull(column: Column<unknown, boolean, boolean>): Condition {
  return {
    sql: `${qualified(column)} IS NOT NULL`,
    params: [],
  };
}

/**
 * Combine conditions with `AND`. Single-arg returns the arg unchanged; zero args
 * are the vacuously-true empty conjunction (`1 = 1`) — the dynamic-filter pattern
 * that collects no clauses and expects "no filter" runs unfiltered.
 */
export function and(...conditions: Condition[]): Condition {
  return combine("AND", conditions);
}

/**
 * Combine conditions with `OR`. Single-arg returns the arg unchanged; zero args
 * are the vacuously-false empty disjunction (`1 = 0`) — "any of nothing" matches
 * no row, mirroring {@link inList} on the empty set.
 */
export function or(...conditions: Condition[]): Condition {
  return combine("OR", conditions);
}

function combine(joiner: "AND" | "OR", conditions: Condition[]): Condition {
  // Zero conditions is the joiner's identity element, and it must render as valid
  // SQL — never a bare `WHERE ` (a syntax error). An empty AND is vacuously TRUE
  // (`1 = 1`, unfiltered); an empty OR is vacuously FALSE (`1 = 0`, matches nothing,
  // like `inList([])`). This keeps the WHERE well-formed and composes correctly when
  // nested: `x AND ()` folds to `x AND TRUE` (= x), `x OR ()` to `x OR FALSE` (= x).
  if (conditions.length === 0) {
    return { sql: joiner === "AND" ? "1 = 1" : "1 = 0", params: [] };
  }

  // A single combined condition is just itself — avoid `( x )` noise in SQL.
  if (conditions.length === 1) return conditions[0]!;

  return {
    sql: conditions.map((c) => `(${c.sql})`).join(` ${joiner} `),
    params: conditions.flatMap((c) => c.params),
  };
}
