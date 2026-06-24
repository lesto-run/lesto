/**
 * The principal resolver — who is making this request, resolved once at the edge
 * of the chain and threaded to every authorization decision downstream.
 *
 * `createGuard` answers "may a subject *holding these roles* do X?" but stays
 * deliberately agnostic about how those roles reach the context (`guard.ts`). The
 * resolver is the other half: a `@lesto/web` middleware that turns the request's
 * session into a {@link Principal} — the authenticated `actor` and the
 * `actorRoles` they hold — and stashes it so two consumers can read one answer:
 *
 *   - it sets the existing `"roles"` context var, so every `can()` guard keeps
 *     working **unchanged** (the guard's `defaultRolesOf` reads exactly that var);
 *   - it exposes the full {@link Principal} via {@link getPrincipal}, so
 *     `@lesto/admin` can attribute a governed write to its `actor` (ADR 0028
 *     Phase 1) — with the resolver as the *sole* source of that actor.
 *
 * Both halves stay decoupled from any concrete user model: `verifySession` and
 * `rolesOf` are injected, so `@lesto/authz` takes **no** `@lesto/auth`
 * dependency — the app reads its own cookie/header and maps its own user to roles.
 *
 * Deny-by-default is structural here too: an unauthenticated request resolves to
 * **empty roles and no principal**, so guards refuse it and a governed admin write
 * has no actor to attribute and must be refused as unattributed. A `verifySession`
 * or `rolesOf` that *throws* aborts the chain (fail-closed — the request 500s and is
 * never granted), never a half-resolved principal a downstream handler could read.
 *
 * The carrier is the two-field `{ actor, actorRoles }` principal. ADR 0028 Phase 1
 * defers the `subject`/`subjectRoles` operator-vs-impersonated split (and the
 * four-field `Principal` it needs) to the phase that first makes them diverge — but
 * the actor still needs *somewhere to live*: the `"roles"` var carries roles only, so
 * a single `"principal"` var threads the actor to admin. That carrier is the Phase-1
 * shape, not the deferred Phase-2 machinery.
 */

import type { Context, Handler } from "@lesto/web";

import { ROLES_VAR } from "./guard";

/** A value that may be delivered now or awaited — the established local convention. */
type MaybePromise<T> = T | Promise<T>;

/**
 * The minimal session shape the resolver needs: a session is a user id.
 *
 * Declared locally and structurally so `@lesto/authz` keeps no `@lesto/auth`
 * dependency. `userId` is a `string` end-to-end (`@lesto/auth`'s `Session.userId`),
 * the single coercion boundary the rest of the operator control plane keys off.
 */
export interface PrincipalSession {
  /** The authenticated user's id — the {@link Principal.actor}. */
  userId: string;
}

/** Who is acting on this request, and the roles they hold — the resolved authorization subject. */
export interface Principal {
  /** The authenticated user id making the request — the sole, trusted-at-source actor. */
  actor: string;

  /** The roles that user holds; the input to every `policy.allows` decision. */
  actorRoles: readonly string[];
}

/** How the resolver learns who is making the request, and what they may do. */
export interface PrincipalResolverOptions {
  /**
   * Verify the request's session, returning it or `undefined` when there is no
   * valid session. Injected so `@lesto/authz` reads no cookies itself: the app
   * pulls the token from `c` however it likes (cookie, header) and hands back the
   * session, keeping this package free of an `@lesto/auth` dependency.
   */
  verifySession: (c: Context) => MaybePromise<PrincipalSession | undefined>;

  /**
   * Resolve an authenticated user's roles — the `userId -> roles` seam. Phase 1
   * ships only the seam; the durable store lands in a later increment, and the
   * dogfood injects a local map. Keyed by the canonical `string` user id.
   */
  rolesOf: (actor: string) => MaybePromise<Iterable<string>>;
}

/** The context var the resolved {@link Principal} is stashed under for admin/handlers to read. */
const PRINCIPAL_VAR = "principal";

/**
 * Read the {@link Principal} a {@link createPrincipalResolver} middleware resolved
 * for this request, or `undefined` when the request is unauthenticated.
 *
 * This is the **sole** source of the `actor` for a governed admin write: a write
 * reached with no principal is unattributed and must be refused (ADR 0028 Phase 1).
 */
export function getPrincipal(c: Context): Principal | undefined {
  return c.get<Principal>(PRINCIPAL_VAR);
}

/**
 * Build the principal-resolver middleware from an app's `verifySession`/`rolesOf`.
 *
 * On every request it verifies the session; an unauthenticated request gets empty
 * roles and no principal (deny-by-default), and an authenticated one is resolved
 * to its `actor` and `actorRoles`, with both the `"roles"` var (for guards) and
 * the full {@link Principal} (for admin, via {@link getPrincipal}) set before the
 * chain continues. An authenticated user with *no* roles is still attributed — the
 * principal carries the actor — but denied, since empty roles satisfy no permission.
 */
export function createPrincipalResolver(options: PrincipalResolverOptions): Handler {
  const { verifySession, rolesOf } = options;

  return async (c, next) => {
    const session = await verifySession(c);

    if (session === undefined) {
      // Unauthenticated: empty roles so deny-by-default holds, and no principal so
      // a governed admin write downstream is refused as unattributed.
      c.set(ROLES_VAR, []);

      return next();
    }

    const actor = session.userId;
    const actorRoles = [...(await rolesOf(actor))];

    c.set(PRINCIPAL_VAR, { actor, actorRoles });
    // Keep the existing "roles" var in sync so every `can()` guard works unchanged.
    c.set(ROLES_VAR, actorRoles);

    return next();
  };
}
