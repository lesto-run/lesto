/**
 * @keel/authz — first-class authorization, the one authorization story.
 *
 *   const policy = definePolicy({
 *     roles: ["guest", "member", "agent", "admin"],
 *     can: {
 *       "listing.read": ["guest", "member", "agent", "admin"],
 *       "listing.write": ["agent", "admin"],
 *       "admin.access": ["admin"],
 *     },
 *   });
 *
 *   const { can, ensure } = createGuard(policy);
 *
 *   app
 *     .use(can("admin.access"))                          // guards a whole subtree
 *     .get("/api/listings/:id", can("listing.read"), show)
 *     .patch("/api/listings/:id", can("listing.write"), update);
 *
 * One declaration, enforced uniformly across API routes and pages, auditable in
 * one place. The current subject's roles arrive via the `"roles"` context var an
 * upstream auth middleware sets (or a custom `rolesOf`), so this layer never
 * couples to a specific user model.
 *
 * Richer authorization — the wildcard grants and cycle-safe role inheritance that
 * used to live in the standalone `@keel/rbac` — fold into the same `definePolicy`:
 *
 *   const policy = definePolicy({
 *     roles: ["author", "editor", "admin"],
 *     can: {
 *       "posts:*": ["author"],          // a resource wildcard grant
 *       "comments:moderate": ["editor"],
 *       "*": ["admin"],                 // the global wildcard
 *     },
 *     inherits: { editor: ["author"], admin: ["editor"] },
 *   });
 *
 *   policy.allows(["editor"], "posts:read");   // true  — via posts:* on author
 *   policy.allows(["editor"], "billing:read"); // false
 *
 * Each role's resolved grant set is computed once and memoized, so enforcement is
 * a membership walk, not a fresh inheritance traversal per request.
 */

export { definePolicy } from "./policy";
export type { Policy, PolicyConfig } from "./policy";

export { AUTHZ_DENIED_KIND, createGuard } from "./guard";
export type { Guard, GuardOptions } from "./guard";

export { AuthzError, KeelError } from "./errors";
export type { AuthzErrorCode } from "./errors";
