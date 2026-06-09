/**
 * The app's migrations — schema, version-stamped and idempotent.
 *
 * The kernel runs these on boot, before any request, so the first query a
 * controller makes hits a migrated schema rather than an empty one. Each entry
 * is recorded in `schema_migrations`, so re-running `createApp` is safe.
 */

import type { MigrationEntry } from "@keel/migrate";

const createPosts: MigrationEntry = {
  version: "001_create_posts",
  migration: {
    up: (schema) => {
      schema.createTable("posts", (t) => {
        t.string("title", { null: false });
        t.text("body", { null: false });
        t.timestamps();
      });
    },

    down: (schema) => {
      schema.dropTable("posts");
    },
  },
};

export const migrations: MigrationEntry[] = [createPosts];
