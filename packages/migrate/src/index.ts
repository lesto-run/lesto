/**
 * @keel/migrate — the migrator: ordering, bookkeeping, and the schema editor for
 * everything the `@keel/db` value layer does not cover (indexes, drops, raw DDL),
 * on an injected SQL database. Tables are defined ONCE as a `@keel/db` schema
 * value and rendered for the dialect — there is no separate string-builder
 * column DSL (ADR 0004 Phase 7.6).
 *
 *   import { createTableSql, defineTable, integer, text } from "@keel/db";
 *
 *   const posts = defineTable("posts", {
 *     id: integer("id").primaryKey({ autoIncrement: true }),
 *     title: text("title").notNull(),
 *   });
 *
 *   const migrator = new Migrator(db, [
 *     {
 *       version: "001_create_posts",
 *       migration: { up: (s) => s.execute(createTableSql(posts, s.dialect)) },
 *     },
 *   ]);
 *   await migrator.migrate();   // applies pending, returns applied versions
 *   await migrator.rollback();  // reverses the most recent
 */

export { Schema } from "./schema";

export { Migrator } from "./migrator";
export type { Migration, MigrationEntry, MigratorOptions } from "./migrator";

export { MigrateError } from "./errors";
export type { MigrateErrorCode } from "./errors";

export type { ColumnOptions, Dialect, IndexOptions, SqlDatabase, SqlStatement } from "./types";
