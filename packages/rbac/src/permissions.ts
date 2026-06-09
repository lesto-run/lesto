import { RbacError } from "./errors";

/** What a single role declares: its own grants plus the roles it inherits from. */
interface Role {
  readonly permissions: readonly string[];

  readonly inherits: readonly string[];
}

/**
 * Role-based authorization, as pure logic.
 *
 * A role grants permission strings like `"posts:read"`. A grant may be a
 * wildcard: `"posts:*"` covers every action on `posts`, and the global `"*"`
 * covers everything. Roles inherit from other roles; inheritance is resolved
 * transitively and is cycle-safe — a role that (directly or indirectly)
 * inherits itself terminates rather than looping forever.
 */
export class Permissions {
  private readonly roles = new Map<string, Role>();

  /**
   * Declare (or redeclare) a role. Returns `this` so definitions chain.
   *
   * `inherits` may name roles that are not defined yet; resolution happens
   * lazily at query time, so definition order does not matter.
   */
  defineRole(name: string, permissions: string[], options?: { inherits?: string[] }): this {
    this.roles.set(name, {
      permissions: [...permissions],
      inherits: [...(options?.inherits ?? [])],
    });

    return this;
  }

  /** Is `name` a defined role? */
  hasRole(name: string): boolean {
    return this.roles.has(name);
  }

  /**
   * Does any of `roleNames` (following inheritance) grant `permission`?
   *
   * Unknown role names contribute nothing — they are simply skipped, never a
   * throw — so an authorization check on stale role data fails closed.
   */
  can(roleNames: string[], permission: string): boolean {
    const granted = new Set<string>();

    for (const name of roleNames) {
      this.collect(name, granted, new Set());
    }

    for (const grant of granted) {
      if (matches(grant, permission)) {
        return true;
      }
    }

    return false;
  }

  /**
   * The fully resolved, de-duplicated permission list for a single role.
   *
   * Throws `RBAC_UNKNOWN_ROLE` if the role is not defined — unlike `can`, this
   * is an introspection call where an unknown role is a programming error.
   */
  permissionsFor(roleName: string): string[] {
    if (!this.roles.has(roleName)) {
      throw new RbacError("RBAC_UNKNOWN_ROLE", `Unknown role "${roleName}".`, {
        role: roleName,
      });
    }

    const granted = new Set<string>();

    this.collect(roleName, granted, new Set());

    return [...granted];
  }

  /**
   * Walk `name` and everything it inherits, folding grants into `granted`.
   *
   * `seen` is the cycle guard: a role already on the current resolution path is
   * skipped, so `A → B → A` terminates instead of recursing forever. Unknown
   * roles drop out here too, which is what lets `can` ignore them.
   */
  private collect(name: string, granted: Set<string>, seen: Set<string>): void {
    if (seen.has(name)) {
      return;
    }

    const role = this.roles.get(name);

    if (role === undefined) {
      return;
    }

    seen.add(name);

    for (const permission of role.permissions) {
      granted.add(permission);
    }

    for (const parent of role.inherits) {
      this.collect(parent, granted, seen);
    }
  }
}

/**
 * Does a granted permission cover a requested one?
 *
 * - `"*"` covers anything.
 * - `"posts:*"` covers any request in the `posts` resource.
 * - otherwise the match is exact.
 */
function matches(grant: string, requested: string): boolean {
  if (grant === "*") {
    return true;
  }

  if (grant.endsWith(":*")) {
    const resource = grant.slice(0, -1); // keep the trailing ":" as the boundary

    return requested.startsWith(resource);
  }

  return grant === requested;
}
