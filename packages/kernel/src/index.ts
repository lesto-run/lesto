/**
 * @lesto/kernel — the application kernel that assembles a Lesto app from its parts.
 *
 *   // Tables are `@lesto/db` schema values, rendered for the dialect (ADR 0004).
 *   import { createTableSql, defineTable, integer, text } from "@lesto/db";
 *   import { lesto } from "@lesto/web";
 *
 *   const posts = defineTable("posts", {
 *     id: integer("id").primaryKey({ autoIncrement: true }),
 *     title: text("title").notNull(),
 *   });
 *
 *   const app = await createApp({
 *     db,
 *     app: lesto().get("/posts", (c) => c.json({ posts: [] })),
 *     migrations: [
 *       {
 *         version: "001_create_posts",
 *         migration: { up: (s) => s.execute(createTableSql(posts, s.dialect)) },
 *       },
 *     ],
 *   });
 *
 *   app.migrationsApplied;                 // ["001_create_posts"]
 *   await app.handle("GET", "/posts");     // the lesto() route's response
 */

export { createApp, KERNEL_DEFAULT_RATE_LIMIT } from "./kernel";
export type { App, LestoAppConfig, KernelDatabase } from "./kernel";

export {
  durableStores,
  installDurableSchema,
  KERNEL_MEMORY_STORES_CODE,
  resetMemoryStoresWarning,
  secureStack,
  stopManagedRateLimitSweeps,
} from "./secure-stack";
export type { DurableStores, SecureStackOptions } from "./secure-stack";
