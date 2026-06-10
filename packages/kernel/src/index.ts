/**
 * @keel/kernel — the application kernel that assembles a Keel app from its parts.
 *
 *   const app = createApp({
 *     db,
 *     router,
 *     controllers: { posts: PostsController },
 *     migrations: [{ version: "001_create_posts", migration: { up: (s) => s.createTable(...) } }],
 *   });
 *
 *   app.migrationsApplied;                 // ["001_create_posts"]
 *   await app.handle("GET", "/posts");     // the PostsController#index response
 */

export { createApp } from "./kernel";
export type { App, AppConfig, KernelDatabase } from "./kernel";

export { secureStack } from "./secure-stack";
export type { SecureStackOptions } from "./secure-stack";
