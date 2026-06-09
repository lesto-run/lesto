/**
 * @keel/migrate — a schema-builder DSL and a migrator, on an injected SQL database.
 *
 *   const schema = new Schema(db);
 *   schema.createTable("posts", (t) => {
 *     t.string("title", { null: false });
 *     t.references("author", { foreignKey: true });
 *     t.timestamps();
 *   });
 *
 *   const migrator = new Migrator(db, [
 *     { version: "001_create_posts", migration: { up: (s) => s.createTable(...) } },
 *   ]);
 *   migrator.migrate();   // applies pending, returns applied versions
 *   migrator.rollback();  // reverses the most recent
 */

export { Schema } from "./schema";

export { TableBuilder } from "./table-builder";

export { Migrator } from "./migrator";
export type { Migration, MigrationEntry } from "./migrator";

export type {
  ColumnOptions,
  IndexOptions,
  ReferenceOptions,
  SqlDatabase,
  SqlStatement,
} from "./types";
