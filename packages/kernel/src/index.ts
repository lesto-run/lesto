/**
 * @keel/kernel — the application kernel that assembles a Keel app from its parts.
 *
 *   // Tables are `@keel/db` schema values, rendered for the dialect (ADR 0004).
 *   import { createTableSql, defineTable, integer, text } from "@keel/db";
 *
 *   const posts = defineTable("posts", {
 *     id: integer("id").primaryKey({ autoIncrement: true }),
 *     title: text("title").notNull(),
 *   });
 *
 *   const app = createApp({
 *     db,
 *     router,
 *     controllers: { posts: PostsController },
 *     migrations: [
 *       {
 *         version: "001_create_posts",
 *         migration: { up: (s) => s.execute(createTableSql(posts, s.dialect)) },
 *       },
 *     ],
 *   });
 *
 *   app.migrationsApplied;                 // ["001_create_posts"]
 *   await app.handle("GET", "/posts");     // the PostsController#index response
 */

export { createApp } from "./kernel";
export type { App, AppConfig, KeelAppConfig, KernelDatabase } from "./kernel";

export { secureStack } from "./secure-stack";
export type { SecureStackOptions } from "./secure-stack";
