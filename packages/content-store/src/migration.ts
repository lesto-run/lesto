import { createTableSql, defineTable, integer, text } from "@volo/db";
import type { MigrationEntry } from "@volo/migrate";

/** The single table that holds every content entry, for every collection. */
export const CONTENT_ENTRIES_TABLE = "content_entries";

/**
 * The content-entries table as a `@volo/db` schema value — the one source of
 * truth for its DDL. One row per entry. The open-ended shape of a content
 * document — arbitrary frontmatter, rendered HTML, computed fields — lives
 * losslessly in the `document` JSON column. A handful of fields are lifted out
 * alongside it (`collection`, `slug`, `status`, `published_at`) precisely because
 * they are the ones worth indexing and querying on. `published_at` and the
 * timestamps are ISO strings (TEXT), matching the rest of Volo's time columns.
 */
const contentEntries = defineTable(CONTENT_ENTRIES_TABLE, {
  id: integer("id").primaryKey({ autoIncrement: true }),
  collection: text("collection").notNull(),
  entryId: text("entry_id").notNull(),
  slug: text("slug").notNull(),
  status: text("status"),
  publishedAt: text("published_at"),
  document: text("document").notNull(),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

/**
 * The migration for content on the SQL substrate.
 *
 * The table DDL is rendered from the schema value above via
 * `createTableSql(table, schema.dialect)` — one DDL system, dialect-aware, no
 * parallel column list. Run it with the standard migrator:
 *
 *   new Migrator(db, [contentEntriesMigration], { dialect }).migrate();
 */
export const contentEntriesMigration: MigrationEntry = {
  version: "0001_create_content_entries",

  migration: {
    async up(schema) {
      // The table must exist before any index references it. On Postgres a
      // CREATE INDEX that races CREATE TABLE fails ("relation does not exist"),
      // so we await the DDL in strict order: table first, then each index.
      await schema.execute(createTableSql(contentEntries, schema.dialect));

      // The identity of an entry is (collection, entry_id) — unique, and the
      // conflict target every upsert resolves against.
      await schema.addIndex(CONTENT_ENTRIES_TABLE, ["collection", "entry_id"], { unique: true });

      // The two access paths the runtime actually takes: by slug, and by status.
      await schema.addIndex(CONTENT_ENTRIES_TABLE, ["collection", "slug"]);
      await schema.addIndex(CONTENT_ENTRIES_TABLE, ["collection", "status"]);
    },

    async down(schema) {
      await schema.dropTable(CONTENT_ENTRIES_TABLE);
    },
  },
};
