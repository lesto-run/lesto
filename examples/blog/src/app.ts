/**
 * Assemble the blog app from its parts.
 *
 * The kernel runs the migration and stands up the dispatch core; we wrap the
 * same database handle in `@keel/db`'s `createDb` so controllers query
 * through a typed seam.
 *
 * Returns both the booted `App` and the `Db` so seed scripts can write
 * through the same handle the controllers read through.
 */

import { createDb } from "@keel/db";
import type { Db } from "@keel/db";
import { createApp } from "@keel/kernel";
import type { App, KernelDatabase } from "@keel/kernel";

import { buildControllers } from "./posts-controller";
import { postsMigration } from "./post";
import { buildRouter } from "./routes";

export function buildApp(handle: KernelDatabase): { app: App; db: Db } {
  const db = createDb(handle);

  const app = createApp({
    db: handle,
    router: buildRouter(),
    controllers: buildControllers(db),
    migrations: [postsMigration],
  });

  return { app, db };
}
