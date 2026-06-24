/**
 * The guard — the bridge from a {@link Policy} to a route's handler chain.
 *
 * `createGuard(policy)` yields `can(permission)`, a Lesto middleware: it reads the
 * current subject's roles from the context, asks the policy, and either falls
 * through (`next`) or answers 403. Drop it into any route or sub-router —
 * `.use(can("admin.access"))` guards an entire admin subtree (its API routes and
 * its pages alike), and `.get(path, can("listing.write"), handler)` guards one
 * endpoint. The same `ensure(c, permission)` is exposed for an imperative,
 * row-level check inside a handler ("can this user edit *this* listing?").
 *
 * How the subject's roles reach the guard is injectable (`rolesOf`), defaulting
 * to the `"roles"` context var an upstream auth middleware sets. So this package
 * stays decoupled from any particular user model — `@lesto/identity`'s `User` has
 * no roles column, and it does not need one: the app maps its user to a role
 * list however it likes and stashes it with `c.set("roles", …)`.
 */

import type { AnyLestoResponse, Context, Handler, LestoRequest } from "@lesto/web";

import type { Policy } from "./policy";

/** The coded `kind` the {@link GuardOptions.onDenied} seam reports a refusal under. */
export const AUTHZ_DENIED_KIND = "authz_forbidden";

/** How a guard finds the current subject's roles, and what it returns when refusing. */
export interface GuardOptions {
  /** Read the subject's roles from the context. Defaults to the `"roles"` context var. */
  rolesOf?: (c: Context) => Iterable<string> | undefined;

  /** Build the refusal response. Defaults to a plain 403. */
  onDeny?: (c: Context, permission: string) => AnyLestoResponse;

  /**
   * Optional observability hook fired the moment the guard refuses — the uniform
   * `onDenied(kind, c)` seam shared across `@lesto/csrf`, `@lesto/authz`, and
   * `@lesto/ratelimit` (owned by auth-security item 6, consumed by OTLP wiring in
   * operability-dx item 3).
   *
   * `kind` is the coded reason (here always {@link AUTHZ_DENIED_KIND}); `c` is the
   * refused {@link LestoRequest} (the guard's `Context.req`, so the seam matches the
   * other two middleware byte-for-byte). Purely observational and distinct from
   * {@link onDeny}: `onDeny` *builds the response*, `onDenied` only *watches* —
   * the refusal is identical whether or not it is wired. A returned promise is
   * awaited so an async sink is not dropped mid-write.
   */
  onDenied?: (kind: string, c: LestoRequest) => void | Promise<void>;
}

/** A policy bound to a way of reading the request's subject — the enforcement surface. */
export interface Guard<Permission extends string> {
  /** Middleware that allows the request past only if the subject holds `permission`. */
  can(permission: Permission): Handler;

  /** The imperative check, for a row-level decision inside a handler. */
  ensure(c: Context, permission: Permission): boolean;
}

/**
 * The context var an upstream auth middleware — or {@link createPrincipalResolver} —
 * sets with the subject's roles. Exported as the single source of truth for the key,
 * so the resolver writes the exact var the guard reads and the two never drift apart
 * behind a duplicated magic string (a drift the no-`tsc` coverage gate can't catch).
 */
export const ROLES_VAR = "roles";

const defaultRolesOf = (c: Context): Iterable<string> | undefined =>
  c.get<readonly string[]>(ROLES_VAR);

const forbidden = (): AnyLestoResponse => ({
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
  const onDenied = options.onDenied;

  const ensure = (c: Context, permission: Permission): boolean =>
    policy.allows(rolesOf(c), permission);

  return {
    ensure,

    can(permission: Permission): Handler {
      return async (c, next) => {
        if (ensure(c, permission)) return next();

        // Announce the refusal before answering — observation only, never a
        // bypass: the `onDeny` response is returned regardless of whether (or how)
        // the hook resolves. `c.req` is passed so the seam is the same shape as the
        // csrf/ratelimit middleware, which key off the bare request.
        if (onDenied !== undefined) {
          await onDenied(AUTHZ_DENIED_KIND, c.req);
        }

        return onDeny(c, permission);
      };
    },
  };
}
