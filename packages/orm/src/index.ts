/**
 * @keel/orm — ActiveRecord for TypeScript. **LEGACY** — superseded by
 * `@keel/db`. See `docs/adr/0004-data-layer-style.md`.
 *
 * This package is preserved unchanged for any out-of-tree app that still
 * depends on it. The Keel workspace itself has no in-tree consumers as of
 * 2026-06-09: every package that did (identity, mailing-lists, admin,
 * blog example, kernel) now uses `@keel/db`'s typed schema + query DSL.
 *
 * **For new code, use `@keel/db`:**
 *
 *     import { defineTable, integer, text, createDb, eq } from "@keel/db";
 *
 *     export const posts = defineTable("posts", {
 *       id: integer("id").primaryKey({ autoIncrement: true }),
 *       title: text("title").notNull(),
 *     });
 *
 *     const db = createDb(sqlAdapter);
 *     const post = db.select().from(posts).where(eq(posts.id, 1)).get();
 *
 * Removal is gated on outside-app adoption — keep using it if you have it,
 * but new code should not adopt it.
 *
 * The old shape, for reference:
 *
 *   class Post extends Model {
 *     static override timestamps = true;
 *     static override validations = { title: { presence: true } };
 *   }
 *
 *   useDatabase(db);
 *   const post = Post.create({ title: "Hello" });
 *   Post.where({ published: true }).order("created_at", "desc").limit(5).all();
 */

export { Model } from "./model";
export type { ValidationRule, ValidationRules } from "./model";

export { Relation } from "./relation";
export type { QuerySource } from "./relation";

export { validate, ValidationErrors } from "./validations";

export { database, resetConnection, useDatabase } from "./connection";

export { OrmError } from "./errors";
export type { OrmErrorCode } from "./errors";

export { camelize, humanize, pluralize, singularize, tableize, underscore } from "./inflector";

export type {
  Attributes,
  SortDirection,
  SqlDatabase,
  SqlStatement,
  WhereConditions,
} from "./types";
