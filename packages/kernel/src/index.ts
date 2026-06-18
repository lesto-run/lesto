/**
 * @volo/kernel — the application kernel that assembles a Volo app from its parts.
 *
 *   // Tables are `@volo/db` schema values, rendered for the dialect (ADR 0004).
 *   import { createTableSql, defineTable, integer, text } from "@volo/db";
 *   import { volo } from "@volo/web";
 *
 *   const posts = defineTable("posts", {
 *     id: integer("id").primaryKey({ autoIncrement: true }),
 *     title: text("title").notNull(),
 *   });
 *
 *   const app = await createApp({
 *     db,
 *     app: volo().get("/posts", (c) => c.json({ posts: [] })),
 *     migrations: [
 *       {
 *         version: "001_create_posts",
 *         migration: { up: (s) => s.execute(createTableSql(posts, s.dialect)) },
 *       },
 *     ],
 *   });
 *
 *   app.migrationsApplied;                 // ["001_create_posts"]
 *   await app.handle("GET", "/posts");     // the volo() route's response
 */

export { createApp, KERNEL_DEFAULT_RATE_LIMIT } from "./kernel";
export type { App, VoloAppConfig, KernelDatabase } from "./kernel";

export {
  durableStores,
  installDurableSchema,
  KERNEL_MEMORY_STORES_CODE,
  resetMemoryStoresWarning,
  secureStack,
} from "./secure-stack";
export type { DurableStores, SecureStackOptions } from "./secure-stack";
