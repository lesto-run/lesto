/**
 * @keel/authz — first-class authorization.
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
 */

export { definePolicy } from "./policy";
export type { Policy, PolicyConfig } from "./policy";

export { createGuard } from "./guard";
export type { Guard, GuardOptions } from "./guard";

export { AuthzError, KeelError } from "./errors";
export type { AuthzErrorCode } from "./errors";
