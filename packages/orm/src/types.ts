/**
 * The shapes the ORM speaks in.
 *
 * Like the queue, the ORM depends only on a minimal SQL surface — never on a
 * concrete driver — so SQLite and Postgres are interchangeable underneath.
 */

export type Attributes = Record<string, unknown>;

export type WhereConditions = Record<string, unknown>;

export type SortDirection = "asc" | "desc";

export interface SqlStatement {
  run(parameters?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(parameters?: unknown[]): unknown;
  all(parameters?: unknown[]): unknown[];
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
}
