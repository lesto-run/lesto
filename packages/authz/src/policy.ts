/**
 * A policy: the single, declarative source for "who can do what".
 *
 * Roles and the permissions each role grants live in one `definePolicy({ roles,
 * can })` value — not scattered as `if (user.isAdmin)` checks across the
 * codebase. That centralization is the whole point: with the policy in one
 * place, the entire authorization surface can be read, reviewed, and audited at
 * once (see the `volo routes` audit), and the guard middleware (see `guard.ts`)
 * enforces it uniformly.
 *
 * Deny-by-default is structural: a permission no role is granted, or a subject
 * with no roles, is refused. A permission that names an undeclared role is a
 * typo, not a policy — so `definePolicy` rejects it at declaration time rather
 * than silently granting nothing.
 *
 * Two richer authorization moves are folded in (the consolidation that retired
 * the standalone `@volo/rbac`):
 *
 * - **Wildcard grants.** A `can` grant may name a wildcard instead of an exact
 *   permission: `"posts:*"` grants every action in the `posts` resource, and the
 *   global `"*"` grants everything. The requested permission is still exact; the
 *   *grant* is what may widen.
 * - **Role inheritance.** A role may `inherits` other roles; a subject holding
 *   the child holds everything the parents grant, resolved transitively. The
 *   resolution is cycle-safe — `admin → staff → admin` terminates rather than
 *   looping — and a role may inherit one declared but not yet processed, since
 *   resolution reads the whole vocabulary, not a definition order.
 */

import { AuthzError } from "./errors";

/** The shape a policy is declared from: the role vocabulary and each permission's grantees. */
export interface PolicyConfig<Role extends string, Permission extends string> {
  /** Every role the app knows — the closed vocabulary the `can` grants are checked against. */
  roles: readonly Role[];

  /**
   * Each permission mapped to the roles that hold it. A role absent here is
   * denied. A grant value may be an exact permission, a resource wildcard
   * (`"posts:*"`), or the global wildcard (`"*"`) — but only as a *grant*; the
   * keys are still the concrete permissions the policy governs.
   */
  can: Readonly<Record<Permission, readonly Role[]>>;

  /**
   * Optional role inheritance: each role mapped to the roles it inherits from. A
   * subject holding a child role holds everything its parents grant, resolved
   * transitively and cycle-safely. Every name on either side must be a declared
   * role, or `definePolicy` throws `AUTHZ_UNKNOWN_ROLE` — the same fail-fast that
   * guards a mistyped grantee.
   */
  inherits?: Readonly<Partial<Record<Role, readonly Role[]>>>;
}

/** A compiled policy: introspectable for auditing, and the oracle the guard asks. */
export interface Policy<Role extends string, Permission extends string> {
  /** The declared role vocabulary. */
  readonly roles: readonly Role[];

  /** Every permission the policy governs, for the audit. */
  permissions(): Permission[];

  /** The roles that hold a permission, for the audit. */
  rolesFor(permission: Permission): readonly Role[];

  /**
   * Does a subject holding `subjectRoles` hold `permission`?
   *
   * Deny-by-default: a subject with no roles (`undefined`) is refused, and so is
   * a permission no role was granted. Otherwise it is true iff some role the
   * subject holds — directly or by inheritance — carries a grant that covers the
   * permission (exact, resource-wildcard, or global-wildcard).
   *
   * Unknown role names in `subjectRoles` contribute nothing — they are skipped,
   * never a throw — so an authorization check on stale role data fails closed.
   */
  allows(subjectRoles: Iterable<string> | undefined, permission: Permission): boolean;
}

/**
 * Does a granted permission pattern cover a requested, concrete permission?
 *
 * - `"*"` covers anything.
 * - `"posts:*"` covers any request in the `posts` resource (anything sharing the
 *   `"posts:"` prefix).
 * - otherwise the match is exact.
 */
function grantCovers(grant: string, requested: string): boolean {
  if (grant === "*") return true;

  if (grant.endsWith(":*")) {
    const prefix = grant.slice(0, -1); // keep the trailing ":" as the boundary

    return requested.startsWith(prefix);
  }

  return grant === requested;
}

/**
 * Compile a {@link PolicyConfig} into a {@link Policy}.
 *
 * Validates at declaration time: every role named in a `can` grant or in an
 * `inherits` edge must be in the `roles` vocabulary, or a coded {@link AuthzError}
 * `AUTHZ_UNKNOWN_ROLE` is thrown — a misspelled role that would otherwise silently
 * grant nothing (or silently inherit nothing) fails loudly instead.
 *
 * Each role's *resolved* grant set — its own grants plus everything it inherits,
 * de-duplicated and cycle-safe — is computed once and memoized, so `allows` is a
 * walk over one already-resolved set per subject role, not a fresh inheritance
 * traversal on every request.
 */
export function definePolicy<Role extends string, Permission extends string>(
  config: PolicyConfig<Role, Permission>,
): Policy<Role, Permission> {
  const declared = new Set<string>(config.roles);

  const entries = Object.entries(config.can) as [Permission, readonly Role[]][];

  // Fail fast: a permission that grants a role outside the vocabulary is a typo.
  for (const [permission, roles] of entries) {
    for (const role of roles) {
      if (!declared.has(role)) {
        throw new AuthzError(
          "AUTHZ_UNKNOWN_ROLE",
          `Permission "${permission}" grants role "${role}", which the policy does not declare.`,
          { permission, role },
        );
      }
    }
  }

  // Inheritance edges: role -> the roles it directly inherits. Validate every
  // name on both sides against the vocabulary with the same fail-fast.
  const parentsOf = new Map<string, readonly string[]>();

  // `Object.entries` only enumerates keys that carry a value, so each `parents`
  // is a concrete list — the `Partial` shape's `| undefined` is a type artifact,
  // not a runtime case.
  for (const [role, parents] of Object.entries(config.inherits ?? {}) as [
    Role,
    readonly Role[],
  ][]) {
    if (!declared.has(role)) {
      throw new AuthzError(
        "AUTHZ_UNKNOWN_ROLE",
        `Inheritance is declared for role "${role}", which the policy does not declare.`,
        { role },
      );
    }

    for (const parent of parents) {
      if (!declared.has(parent)) {
        throw new AuthzError(
          "AUTHZ_UNKNOWN_ROLE",
          `Role "${role}" inherits "${parent}", which the policy does not declare.`,
          { role, parent },
        );
      }
    }

    parentsOf.set(role, parents);
  }

  // Direct grants: role -> the permission patterns it carries on its own. A role
  // may appear in several `can` entries; collect each grantee's own patterns.
  const directGrants = new Map<string, string[]>();

  for (const [permission, roles] of entries) {
    for (const role of roles) {
      let own = directGrants.get(role);

      if (own === undefined) {
        own = [];
        directGrants.set(role, own);
      }

      own.push(permission);
    }
  }

  // Resolved grants, memoized per role: own patterns + everything inherited,
  // de-duplicated, cycle-safe. Computed lazily and cached on first ask.
  const resolved = new Map<string, ReadonlySet<string>>();

  const resolveGrants = (role: string): ReadonlySet<string> => {
    const cached = resolved.get(role);

    if (cached !== undefined) return cached;

    const grants = new Set<string>();
    const seen = new Set<string>();

    const collect = (name: string): void => {
      // The cycle guard: a role already on the current resolution path is
      // skipped, so `a -> b -> a` terminates instead of recursing forever.
      if (seen.has(name)) return;

      seen.add(name);

      for (const pattern of directGrants.get(name) ?? []) {
        grants.add(pattern);
      }

      for (const parent of parentsOf.get(name) ?? []) {
        collect(parent);
      }
    };

    collect(role);

    resolved.set(role, grants);

    return grants;
  };

  return {
    roles: config.roles,

    permissions(): Permission[] {
      return entries.map(([permission]) => permission);
    },

    rolesFor(permission: Permission): readonly Role[] {
      return config.can[permission] ?? [];
    },

    allows(subjectRoles: Iterable<string> | undefined, permission: Permission): boolean {
      if (subjectRoles === undefined) return false;

      for (const role of subjectRoles) {
        // Unknown roles resolve to an empty grant set — they contribute nothing.
        for (const grant of resolveGrants(role)) {
          if (grantCovers(grant, permission)) return true;
        }
      }

      return false;
    },
  };
}
