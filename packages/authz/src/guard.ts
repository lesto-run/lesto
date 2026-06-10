/**
 * The guard — the bridge from a {@link Policy} to a route's handler chain.
 *
 * `createGuard(policy)` yields `can(permission)`, a Keel middleware: it reads the
 * current subject's roles from the context, asks the policy, and either falls
 * through (`next`) or answers 403. Drop it into any route or sub-router —
 * `.use(can("admin.access"))` guards an entire admin subtree (its API routes and
 * its pages alike), and `.get(path, can("listing.write"), handler)` guards one
 * endpoint. The same `ensure(c, permission)` is exposed for an imperative,
 * row-level check inside a handler ("can this user edit *this* listing?").
 *
 * How the subject's roles reach the guard is injectable (`rolesOf`), defaulting
 * to the `"roles"` context var an upstream auth middleware sets. So this package
 * stays decoupled from any particular user model — `@keel/identity`'s `User` has
 * no roles column, and it does not need one: the app maps its user to a role
 * list however it likes and stashes it with `c.set("roles", …)`.
 */

import type { AnyKeelResponse, Context, Handler } from "@keel/web";

import type { Policy } from "./policy";

/** How a guard finds the current subject's roles, and what it returns when refusing. */
export interface GuardOptions {
  /** Read the subject's roles from the context. Defaults to the `"roles"` context var. */
  rolesOf?: (c: Context) => Iterable<string> | undefined;

  /** Build the refusal response. Defaults to a plain 403. */
  onDeny?: (c: Context, permission: string) => AnyKeelResponse;
}

/** A policy bound to a way of reading the request's subject — the enforcement surface. */
export interface Guard<Permission extends string> {
  /** Middleware that allows the request past only if the subject holds `permission`. */
  can(permission: Permission): Handler;

  /** The imperative check, for a row-level decision inside a handler. */
  ensure(c: Context, permission: Permission): boolean;
}

/** The context var an upstream auth middleware sets with the subject's roles. */
const ROLES_VAR = "roles";

const defaultRolesOf = (c: Context): Iterable<string> | undefined =>
  c.get<readonly string[]>(ROLES_VAR);

const forbidden = (): AnyKeelResponse => ({
  status: 403,
  headers: { "content-type": "text/plain" },
  body: "Forbidden",
});

/**
 * Bind a {@link Policy} to a way of reading the request's subject, yielding the
 * guard middleware + the imperative check.
 */
export function createGuard<Role extends string, Permission extends string>(
  policy: Policy<Role, Permission>,
  options: GuardOptions = {},
): Guard<Permission> {
  const rolesOf = options.rolesOf ?? defaultRolesOf;
  const onDeny = options.onDeny ?? forbidden;

  const ensure = (c: Context, permission: Permission): boolean =>
    policy.allows(rolesOf(c), permission);

  return {
    ensure,

    can(permission: Permission): Handler {
      return (c, next) => (ensure(c, permission) ? next() : onDeny(c, permission));
    },
  };
}
