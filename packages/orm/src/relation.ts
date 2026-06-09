import type { Attributes, SortDirection, SqlDatabase, WhereConditions } from "./types";

/**
 * A lazy, immutable, chainable query.
 *
 *   Post.where({ published: true }).order("created_at", "desc").limit(5).all()
 *
 * Nothing touches the database until a terminal method (`all`, `first`, `count`,
 * `pluck`). Each builder method returns a fresh Relation, so chains never alias.
 */

/** What a Relation needs from its model to run — the seam that keeps them decoupled. */
export interface QuerySource<T> {
  readonly table: string;
  readonly primaryKey: string;
  database(): SqlDatabase;
  instantiate(row: Attributes): T;
}

interface Condition {
  readonly sql: string;
  readonly params: readonly unknown[];
}

// SQLite binds numbers, strings, bigints, buffers, null — coerce the JS types we store.
function bindable(value: unknown): unknown {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  return value === undefined ? null : value;
}

export class Relation<T> implements Iterable<T> {
  private readonly source: QuerySource<T>;

  private readonly wheres: readonly Condition[];

  private readonly orders: readonly string[];

  private readonly limitValue: number | undefined;

  private readonly offsetValue: number | undefined;

  constructor(
    source: QuerySource<T>,
    state: {
      wheres?: readonly Condition[];
      orders?: readonly string[];
      limit?: number | undefined;
      offset?: number | undefined;
    } = {},
  ) {
    this.source = source;
    this.wheres = state.wheres ?? [];
    this.orders = state.orders ?? [];
    this.limitValue = state.limit;
    this.offsetValue = state.offset;
  }

  private extend(state: {
    wheres?: readonly Condition[];
    orders?: readonly string[];
    limit?: number | undefined;
    offset?: number | undefined;
  }): Relation<T> {
    return new Relation(this.source, {
      wheres: state.wheres ?? this.wheres,
      orders: state.orders ?? this.orders,
      limit: state.limit ?? this.limitValue,
      offset: state.offset ?? this.offsetValue,
    });
  }

  where(conditions: WhereConditions): Relation<T> {
    const added: Condition[] = Object.entries(conditions).map(([column, value]) => {
      if (value === null) {
        return { sql: `${column} IS NULL`, params: [] };
      }

      if (Array.isArray(value)) {
        const placeholders = value.map(() => "?").join(", ");

        return { sql: `${column} IN (${placeholders})`, params: value.map(bindable) };
      }

      return { sql: `${column} = ?`, params: [bindable(value)] };
    });

    return this.extend({ wheres: [...this.wheres, ...added] });
  }

  order(column: string, direction: SortDirection = "asc"): Relation<T> {
    const dir = direction === "desc" ? "DESC" : "ASC";

    return this.extend({ orders: [...this.orders, `${column} ${dir}`] });
  }

  limit(count: number): Relation<T> {
    return this.extend({ limit: count });
  }

  offset(count: number): Relation<T> {
    return this.extend({ offset: count });
  }

  all(): T[] {
    const { sql, params } = this.build("*");

    return this.source
      .database()
      .prepare(sql)
      .all(params)
      .map((row) => this.source.instantiate(row as Attributes));
  }

  first(): T | undefined {
    const ordered = this.orders.length > 0 ? this : this.order(this.source.primaryKey);
    const { sql, params } = ordered.limit(1).build("*");
    const row = this.source.database().prepare(sql).get(params);

    return row ? this.source.instantiate(row as Attributes) : undefined;
  }

  count(): number {
    const { sql, params } = this.build("COUNT(*) AS n");

    return (this.source.database().prepare(sql).get(params) as { n: number }).n;
  }

  exists(): boolean {
    return this.count() > 0;
  }

  pluck(column: string): unknown[] {
    const { sql, params } = this.build(column);

    return this.source
      .database()
      .prepare(sql)
      .all(params)
      .map((row) => (row as Attributes)[column]);
  }

  [Symbol.iterator](): Iterator<T> {
    return this.all()[Symbol.iterator]();
  }

  private build(select: string): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const parts = [`SELECT ${select} FROM ${this.source.table}`];

    if (this.wheres.length > 0) {
      parts.push(`WHERE ${this.wheres.map((where) => where.sql).join(" AND ")}`);

      for (const where of this.wheres) {
        params.push(...where.params);
      }
    }

    if (this.orders.length > 0) {
      parts.push(`ORDER BY ${this.orders.join(", ")}`);
    }

    if (this.limitValue !== undefined) {
      parts.push(`LIMIT ${Number(this.limitValue)}`);
    }

    if (this.offsetValue !== undefined) {
      parts.push(`OFFSET ${Number(this.offsetValue)}`);
    }

    return { sql: parts.join(" "), params };
  }
}
