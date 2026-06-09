/**
 * Assemble the blog app from its parts.
 *
 * This is the whole wiring: hand the kernel a database, the routes, the
 * controllers keyed by route-target name, and the migrations to bring the schema
 * up on boot. The kernel owns the assembly order (connect ORM, migrate, stand up
 * dispatch); we just declare the parts.
 */

import { createApp } from "@keel/kernel";
import type { App, KernelDatabase } from "@keel/kernel";

import { buildRouter } from "./routes";
import { migrations } from "./migrations";
import { PostsController } from "./posts-controller";

export function buildApp(db: KernelDatabase): App {
  return createApp({
    db,
    router: buildRouter(),
    controllers: { posts: PostsController },
    migrations,
  });
}
