/**
 * @keel/admin — an admin operations layer over @keel/orm models.
 *
 *   const admin = new Admin([
 *     { name: "posts", model: Post, fields: ["title", "body"] },
 *   ]);
 *
 *   admin.resources();          // [{ name: "posts", fields: ["title", "body"] }]
 *   admin.list("posts");        // [{ id, title, body }, ...]
 *   admin.create("posts", { title: "Hello", body: "..." });
 *
 * The generic CRUD backbone a WordPress-style admin UI sits on: it resolves a
 * resource name to its model and projects every record to `{ id, ...fields }`.
 */

export { Admin } from "./admin";
export type { AdminResource } from "./admin";

export { AdminError } from "./errors";
export type { AdminErrorCode } from "./errors";
