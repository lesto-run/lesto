/**
 * @keel/rbac — role-based authorization, as pure logic.
 *
 *   const perms = new Permissions();
 *   perms.defineRole("author", ["posts:*"]);
 *   perms.defineRole("editor", ["comments:moderate"], { inherits: ["author"] });
 *
 *   perms.can(["editor"], "posts:read");        // true  (via posts:* on author)
 *   perms.can(["editor"], "billing:refund");    // false
 *   perms.permissionsFor("editor");             // ["comments:moderate", "posts:*"]
 */

export { Permissions } from "./permissions";

export { KeelError, RbacError } from "./errors";
export type { RbacErrorCode } from "./errors";
