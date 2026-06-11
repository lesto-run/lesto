/**
 * The fixture project's app — what `keel` loads at a project root.
 *
 * Default-exports a KeelAppConfig (the { db, app, migrations } object accepted
 * by createApp). Spawned by the e2e test to prove the real bin loads a project
 * and runs a command end-to-end against a code-first `keel()` app.
 */

import { keel } from "@keel/web";
import type { KeelAppConfig } from "@keel/kernel";
import type { MigrationEntry } from "@keel/migrate";
import { openSqlite } from "@keel/runtime";

const app = keel()
  .get("/posts", (c) => c.json({ posts: [] }))
  .post("/posts", (c) => c.json({ created: true }, 201))
  .get("/posts/:id", (c) => c.json({ id: c.param("id") }));

const migrations: MigrationEntry[] = [
  {
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
  },
];

const { db } = await openSqlite();

const config: KeelAppConfig = {
  db,
  app,
  migrations,
};

export default config;
