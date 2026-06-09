/**
 * The fixture project's app — what `keel` loads at a project root.
 *
 * Default-exports an AppConfig (the { db, router, controllers, migrations }
 * object accepted by createApp). Spawned by the e2e test to prove the real bin
 * loads a project and runs a command end-to-end.
 */

import { Router } from "@keel/router";
import { Controller } from "@keel/web";
import type { ControllerClass, KeelResponse } from "@keel/web";
import type { AppConfig } from "@keel/kernel";
import type { MigrationEntry } from "@keel/migrate";

import { openDatabase } from "./src/database";

class PostsController extends Controller {
  index(): KeelResponse {
    return this.json({ posts: [] });
  }
}

const router = new Router();

router.resources("posts");

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

const db = await openDatabase();

const config: AppConfig = {
  db,
  router,
  controllers: { posts: PostsController as ControllerClass },
  migrations,
};

export default config;
