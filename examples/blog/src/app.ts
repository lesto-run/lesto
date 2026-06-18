/**
 * Assemble the blog app from its parts.
 *
 * One composable `volo()` app carries both surfaces over the same data: a
 * `.page("/posts")` that streams the SSR'd HTML page, and a `GET /api/posts`
 * that returns the same posts as JSON. Built through a factory so the route
 * handlers close over the typed `@volo/db` handle — no module-scoped database
 * global.
 *
 * The kernel runs the migration and stands up dispatch; we wrap the same
 * database handle in `@volo/db`'s `createDb` so handlers query through a typed
 * seam. Returns both the booted `App` and the `Db` so seed scripts can write
 * through the same handle the handlers read through.
 */

import { createDb } from "@volo/db";
import type { Db } from "@volo/db";
import { createApp } from "@volo/kernel";
import type { App, KernelDatabase } from "@volo/kernel";
import { volo } from "@volo/web";
import type { Volo } from "@volo/web";

import { BlogPage } from "./page";
import { countReactions, listPosts, postsMigration } from "./post";
import { reactionsSource } from "./reactions-source";

/**
 * The blog's routes + page, closing over the typed `Db` they query through.
 *
 * `.data(reactionsSource, …)` registers the Reactions island's data loader and
 * auto-exposes it at `/__volo/data/reactions` (a `shared` source → publicly
 * cacheable-but-revalidated). On the dynamically rendered `/posts` page the
 * framework resolves it AT RENDER and inlines it into the `ssr: true` island —
 * the canonical island, 0 RTT (ADR 0012). `.client("/client.js")` declares the
 * client runtime, so every page emits the head module tag that hydrates it.
 */
export function buildBlog(db: Db): Volo {
  return volo()
    .client("/client.js")
    .data(reactionsSource, () => countReactions(db))
    .page("/posts", {
      load: async () => ({ posts: await listPosts(db) }),
      component: BlogPage,
      metadata: () => ({ title: "The Volo Blog" }),
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
