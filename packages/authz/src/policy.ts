/**
 * A policy: the single, declarative source for "who can do what".
 *
 * Roles and the permissions each role grants live in one `definePolicy({ roles,
 * can })` value — not scattered as `if (user.isAdmin)` checks across the
 * codebase. That centralization is the whole point: with the policy in one
 * place, the entire authorization surface can be read, reviewed, and audited at
 * once (see the `keel routes` audit), and the guard middleware (see `guard.ts`)
 * enforces it uniformly.
 *
 * Deny-by-default is structural: a permission no role is granted, or a subject
 * with no roles, is refused. A permission that names an undeclared role is a
 * typo, not a policy — so `definePolicy` rejects it at declaration time rather
 * than silently granting nothing.
 */

import { AuthzError } from "./errors";

/** The shape a policy is declared from: the role vocabulary and each permission's grantees. */
export interface PolicyConfig<Role extends string, Permission extends string> {
  /** Every role the app knows — the closed vocabulary the `can` grants are checked against. */
  roles: readonly Role[];

  /** Each permission mapped to the roles that hold it. A role absent here is denied. */
  can: Readonly<Record<Permission, readonly Role[]>>;
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
   * a permission no role was granted. Otherwise it is true iff the subject holds
   * any role the permission grants.
   */
  allows(subjectRoles: Iterable<string> | undefined, permission: Permission): boolean;
}

/**
 * Compile a {@link PolicyConfig} into a {@link Policy}.
 *
 * Validates at declaration time: every role named in a `can` grant must be in
 * the `roles` vocabulary, or a coded {@link AuthzError} `AUTHZ_UNKNOWN_ROLE` is
 * thrown — a misspelled role that would otherwise silently grant nothing fails
 * loudly instead. The grants are precompiled to role sets so `allows` is a
 * membership test, not a scan.
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

  // Precompiled grants: permission -> the set of roles that hold it.
  const grants = new Map<string, ReadonlySet<string>>(
    entries.map(([permission, roles]) => [permission, new Set<string>(roles)]),
  );

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

      const allowed = grants.get(permission);

      // An unknown / ungranted permission is denied — the safe default.
      if (allowed === undefined) return false;

      for (const role of subjectRoles) {
        if (allowed.has(role)) return true;
      }

      return false;
    },
  };
}
