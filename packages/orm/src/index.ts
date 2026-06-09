/**
 * @keel/orm — ActiveRecord for TypeScript.
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
