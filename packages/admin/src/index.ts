/**
 * @lesto/admin — an admin operations layer over @lesto/db tables.
 *
 *   const admin = createAdmin(
 *     db,
 *     [
 *       {
 *         name: "posts",
 *         table: posts,
 *         insertSchema: z.object({ title: z.string().min(1), body: z.string() }),
 *         updateSchema: z.object({ title: z.string().min(1).optional(), body: z.string().optional() }),
 *         fields: ["title", "body"],
 *         permissions: { read: "posts:read", create: "posts:write" },
 *       },
 *     ],
 *     { policy }, // governed — or { ungoverned: true } for the loud opt-out
 *   );
 *
 *   admin.resources();                       // [{ name: "posts", fields: ["title", "body"] }]
 *   admin.list("posts", undefined, principal); // [{ id, title, body }, ...] — checks "posts:read"
 *   admin.create("posts", { title: "Hello", body: "..." }, principal); // checks "posts:write"
 *
 * The generic CRUD backbone a WordPress-style admin UI sits on. CRUD goes
 * through `@lesto/db`; input validation goes through Zod schemas (per ADR
 * 0005); projection honors the per-resource `fields` allow-list; and every verb
 * is gated by an injected `@lesto/authz` policy (ADR 0028 Phase 1) — `read` for
 * `list`/`get`, the matching write permission for each mutation.
 */

export { createAdmin } from "./admin";
export type {
  Admin,
  AdminOptions,
  AdminPolicy,
  AdminResource,
  AuditEvent,
  ListOptions,
  MutationAction,
  MutationContext,
  ResourcePermissions,
} from "./admin";

export { AdminError } from "./errors";
export type { AdminErrorCode } from "./errors";
