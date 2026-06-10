/**
 * @keel/admin — an admin operations layer over @keel/db tables.
 *
 *   const admin = createAdmin(db, [
 *     {
 *       name: "posts",
 *       table: posts,
 *       insertSchema: z.object({ title: z.string().min(1), body: z.string() }),
 *       updateSchema: z.object({ title: z.string().min(1).optional(), body: z.string().optional() }),
 *       fields: ["title", "body"],
 *     },
 *   ]);
 *
 *   admin.resources();      // [{ name: "posts", fields: ["title", "body"] }]
 *   admin.list("posts");    // [{ id, title, body }, ...]
 *   admin.create("posts", { title: "Hello", body: "..." });
 *
 * The generic CRUD backbone a WordPress-style admin UI sits on. CRUD goes
 * through `@keel/db`; input validation goes through Zod schemas (per ADR
 * 0005); projection honors the per-resource `fields` allow-list.
 */

export { createAdmin } from "./admin";
export type { Admin, AdminResource } from "./admin";

export { AdminError } from "./errors";
export type { AdminErrorCode } from "./errors";
