/**
 * Assemble the blog app from its parts.
 *
 * One composable `keel()` app carries both surfaces over the same data: a
 * `.page("/posts")` that streams the SSR'd HTML page, and a `GET /api/posts`
 * that returns the same posts as JSON. Built through a factory so the route
 * handlers close over the typed `@keel/db` handle — no module-scoped database
 * global.
 *
 * The kernel runs the migration and stands up dispatch; we wrap the same
 * database handle in `@keel/db`'s `createDb` so handlers query through a typed
 * seam. Returns both the booted `App` and the `Db` so seed scripts can write
 * through the same handle the handlers read through.
 */

import { createDb } from "@keel/db";
import type { Db } from "@keel/db";
import { createApp } from "@keel/kernel";
import type { App, KernelDatabase } from "@keel/kernel";
import { keel } from "@keel/web";
import type { Keel } from "@keel/web";

import { BlogPage } from "./page";
import { listPosts, postsMigration } from "./post";

/** The blog's routes + page, closing over the typed `Db` they query through. */
export function buildBlog(db: Db): Keel {
  return keel()
    .page("/posts", {
      load: async () => ({ posts: await listPosts(db) }),
      component: BlogPage,
      metadata: () => ({ title: "The Keel Blog" }),
    })
    .get("/api/posts", async (c) => c.json({ posts: await listPosts(db) }));
}

export async function buildApp(handle: KernelDatabase): Promise<{ app: App; db: Db }> {
  const db = createDb(handle);

  const app = await createApp({
    db: handle,
    app: buildBlog(db),
    migrations: [postsMigration],
  });

  return { app, db };
}
