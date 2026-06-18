/**
 * The fixture project's app — what `volo` loads at a project root.
 *
 * Default-exports a VoloAppConfig (the { db, app, migrations } object accepted
 * by createApp). Spawned by the e2e test to prove the real bin loads a project
 * and runs a command end-to-end against a code-first `volo()` app.
 */

import { createTableSql, defineTable, dropTableSql, integer, text } from "@volo/db";
import { volo } from "@volo/web";
import type { VoloAppConfig } from "@volo/kernel";
import type { MigrationEntry } from "@volo/migrate";
import { openSqlite } from "@volo/runtime";

const app = volo()
  .get("/posts", (c) => c.json({ posts: [] }))
  .post("/posts", (c) => c.json({ created: true }, 201))
  .get("/posts/:id", (c) => c.json({ id: c.param("id") }));

// Schema-as-value DDL (the one DDL system) — rendered for the migrator's dialect.
const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

const migrations: MigrationEntry[] = [
  {
    version: "001_create_posts",
    migration: {
      up: (schema) => {
        schema.execute(createTableSql(posts, schema.dialect));
      },

      down: (schema) => {
        schema.execute(dropTableSql(posts));
      },
    },
  },
];

const { db } = await openSqlite();

const config: VoloAppConfig = {
  db,
  app,
  migrations,
};

export default config;
