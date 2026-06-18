/**
 * The fixture project's app — what `lesto` loads at a project root.
 *
 * Default-exports a LestoAppConfig (the { db, app, migrations } object accepted
 * by createApp). Spawned by the e2e test to prove the real bin loads a project
 * and runs a command end-to-end against a code-first `lesto()` app.
 */

import { createTableSql, defineTable, dropTableSql, integer, text } from "@lesto/db";
import { lesto } from "@lesto/web";
import type { LestoAppConfig } from "@lesto/kernel";
import type { MigrationEntry } from "@lesto/migrate";
import { openSqlite } from "@lesto/runtime";

const app = lesto()
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

const config: LestoAppConfig = {
  db,
  app,
  migrations,
};

export default config;
