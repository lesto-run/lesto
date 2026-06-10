import type { MigrationEntry } from "@keel/migrate";

/** The single table that holds every content entry, for every collection. */
export const CONTENT_ENTRIES_TABLE = "content_entries";

/**
 * The schema for content on the SQL substrate.
 *
 * One row per entry. The open-ended shape of a content document — arbitrary
 * frontmatter, rendered HTML, computed fields — lives losslessly in the
 * `document` JSON column. A handful of fields are lifted out alongside it
 * (`collection`, `slug`, `status`, `published_at`) precisely because they are
 * the ones worth indexing and querying on.
 *
 * Run it with the standard migrator:
 *
 *   new Migrator(db, [contentEntriesMigration]).migrate();
 */
export const contentEntriesMigration: MigrationEntry = {
  version: "0001_create_content_entries",

  migration: {
    async up(schema) {
      // The table must exist before any index references it. On Postgres a
      // CREATE INDEX that races CREATE TABLE fails ("relation does not exist"),
      // so we await the DDL in strict order: table first, then each index.
      await schema.createTable(CONTENT_ENTRIES_TABLE, (t) => {
        t.string("collection", { null: false });
        t.string("entry_id", { null: false });
        t.string("slug", { null: false });
        t.string("status");
        t.datetime("published_at");
        t.text("document", { null: false });
        t.timestamps();
      });

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
