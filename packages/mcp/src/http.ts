/**
 * The Resource Server half of remote MCP (ADR 0028 Phase 3b).
 *
 * Remote MCP serves agents over HTTP, so the control plane must authenticate a
 * bearer token instead of a launch-time session. This module is the RS *validation
 * logic* — pure, offline, and fully tested — that the (coverage-excluded)
 * Streamable-HTTP transport wires to real requests. Keeping every governance
 * decision here, not in the transport, is deliberate: the security-critical checks
 * (audience, the scope ceiling, the policy floor) live in tested code; the transport
 * only shapes HTTP.
 *
 * Three moves, all AS-agnostic:
 *
 *   - **Validate** a token via the INJECTED {@link VerifyAccessToken} seam — so
 *     `@lesto/mcp` does the JWKS/`jose` verification NOWHERE itself and takes no
 *     issuer dependency. A configured external IdP (Auth0/Okta/WorkOS/Entra) is the
 *     first issuer; the first-party ADR 0029 AS lands later behind the *same* seam,
 *     no RS change. The seam validates offline (cached JWKS), so authentication makes
 *     no network call on the hot path.
 *   - **Bind** the validated `subject` to a {@link Principal} via the same
 *     `rolesOf` seam the stdio path uses (`subject → roles`), feeding the existing
 *     principal/authz path — and enforce that the token's audience names THIS
 *     resource, refusing any token minted for another audience (no passthrough, the
 *     confused-deputy guard).
 *   - **Authorize** each action as the INTERSECTION of the token's scope ceiling and
 *     the policy floor ({@link authorizeBearer}): a read-scoped token can never
 *     reach a write, and a privileged subject is still bounded by the token's scope.
 *
 * Plus the RFC 9728 Protected Resource Metadata ({@link protectedResourceMetadata})
 * a client reads from `.well-known/oauth-protected-resource` to discover where to get
 * a token.
 */

import type { Policy, Principal } from "@lesto/authz";

/** A value delivered now or awaited — the established local convention. */
type MaybePromise<T> = T | Promise<T>;

/** The claims a validated access token yields — the {@link VerifyAccessToken} seam's output. */
export interface AccessTokenClaims {
  /** The token's subject (`sub`) — the authenticated user id, i.e. the {@link Principal.actor}. */
  subject: string;

  /**
   * The token's audience (`aud`) — who the token was minted FOR. A JWT `aud` is a
   * string or an array of strings; both shapes are checked against this RS's own
   * resource identifier, and a token audienced elsewhere is refused.
   */
  audience: string | readonly string[];

  /**
   * The OAuth scopes the token grants — the enforced ceiling on what its bearer may
   * do (a `mcp:read` token can never reach a write). The seam parses the space-
   * delimited `scope` claim (RFC 6749 §3.3) into this list.
   */
  scopes: readonly string[];
}

/**
 * Validate a bearer access token, returning its {@link AccessTokenClaims} or
 * `undefined` when the token is absent, expired, or forged.
 *
 * INJECTED — so `@lesto/mcp` carries no `jose`/JWKS dependency and no coupling to any
 * one issuer. The implementation validates the JWT against the configured issuer's
 * JWKS (an external IdP first; the ADR 0029 AS later, behind this SAME seam) and does
 * so OFFLINE from cached keys, so authentication never blocks on an issuer round-trip.
 */
export type VerifyAccessToken = (token: string) => MaybePromise<AccessTokenClaims | undefined>;

/**
 * Extract the bearer token from an `Authorization` header value, or `undefined` when
 * the header is absent or not a well-formed `Bearer <token>`.
 *
 * The scheme is matched case-insensitively (RFC 6750 §2.1), and the token must be a
 * single non-empty run with no embedded spaces. The transport reads the bearer from
 * the `Authorization` header ONLY — never a query string, where it would leak into
 * logs and referrers — so this parser is the sole entry point for a token.
 */
export function bearerFromAuthorization(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;

  const match = /^Bearer +(\S+)$/i.exec(header.trim());

  return match?.[1];
}

/** RFC 9728 Protected Resource Metadata — the body served at `.well-known/oauth-protected-resource`. */
export interface ProtectedResourceMetadata {
  /** This RS's own resource identifier — the canonical URL tokens must be audienced to. */
  resource: string;

  /** The issuer identifier(s) whose tokens this RS accepts — where a client gets a token. */
  authorization_servers: readonly string[];

  /**
   * How a bearer token may be presented. Always `["header"]`: the RS accepts the token
   * in the `Authorization` header only, never a query string or form body.
   */
  bearer_methods_supported: readonly string[];

  /** The scopes this RS understands, advertised so a client can request them. Omitted when unset. */
  scopes_supported?: readonly string[];
}

/** What {@link protectedResourceMetadata} needs to describe this Resource Server. */
export interface ProtectedResourceMetadataOptions {
  /** This RS's own resource identifier — the audience tokens must carry. */
  resource: string;

  /** The issuer(s) this RS trusts to mint tokens — the configured external IdP first. */
  authorizationServers: readonly string[];

  /** The scopes this RS understands; advertised to clients when given. */
  scopesSupported?: readonly string[];
}

/**
 * Build the RFC 9728 Protected Resource Metadata document for this RS.
 *
 * `bearer_methods_supported` is fixed to `["header"]` — the RS only ever reads a token
 * from the `Authorization` header. `scopes_supported` is advertised only when the
 * caller declares a vocabulary (`exactOptionalPropertyTypes`: the key is carried only
 * when present, never as an explicit `undefined`).
 */
export function protectedResourceMetadata(
  options: ProtectedResourceMetadataOptions,
): ProtectedResourceMetadata {
  return {
    resource: options.resource,
    authorization_servers: options.authorizationServers,
    bearer_methods_supported: ["header"],
    ...(options.scopesSupported === undefined ? {} : { scopes_supported: options.scopesSupported }),
  };
}

/** A token that passed validation AND the audience check — safe to act on. */
export interface BearerSession {
  /** The principal the token's subject resolves to ({@link Principal.actor} + roles). */
  principal: Principal;

  /** The token's granted scopes — the ceiling {@link authorizeBearer} enforces per action. */
  scopes: readonly string[];
}

/** The seams {@link createBearerAuthenticator} composes into a {@link BearerSession}. */
export interface BearerAuthenticatorOptions {
  /** Validate the raw token and surface its claims — the injected, AS-agnostic seam. */
  verifyAccessToken: VerifyAccessToken;

  /**
   * This RS's own resource identifier. A validated token whose audience does NOT name
   * this resource is refused — no passthrough — so a token a user granted to a
   * different service can never be replayed here (the confused-deputy guard).
   */
  resource: string;

  /**
   * Resolve the authenticated subject's roles — the `subject -> roles` seam, the same
   * one the stdio path uses (e.g. `@lesto/identity`'s `rolesOf`). A subject with no
   * roles is still attributed (the principal carries the actor) but denied downstream,
   * since empty roles satisfy no permission.
   */
  rolesOf: (actor: string) => MaybePromise<Iterable<string>>;
}

/** Does a token audience (string or set) name this resource? */
function audienceNames(audience: string | readonly string[], resource: string): boolean {
  return typeof audience === "string" ? audience === resource : audience.includes(resource);
}

/**
 * Build the RS's bearer authenticator: validate the token via the injected seam,
 * enforce that its audience names THIS resource, then bind the subject to a principal.
 *
 * Returns the {@link BearerSession} (principal + scope ceiling) on success, or
 * `undefined` for any token that is absent, invalid/expired (the seam returned
 * nothing), or minted for another audience — every one of which the transport maps to
 * a `401`. The audience check is the no-passthrough rule: a token is accepted only if
 * it was issued for this exact resource.
 */
export function createBearerAuthenticator(
  options: BearerAuthenticatorOptions,
): (token: string) => Promise<BearerSession | undefined> {
  const { verifyAccessToken, resource, rolesOf } = options;

  return async (token) => {
    const claims = await verifyAccessToken(token);

    // Invalid, expired, or forged — the seam refused it.
    if (claims === undefined) return undefined;

    // Reject any token not minted for this resource: no passthrough of a token a user
    // granted to some other audience.
    if (!audienceNames(claims.audience, resource)) return undefined;

    const actor = claims.subject;
    const actorRoles = [...(await rolesOf(actor))];

    return { principal: { actor, actorRoles }, scopes: claims.scopes };
  };
}

/** The inputs to the RS authorization decision ({@link authorizeBearer}). */
export interface BearerAuthorization {
  /** The validated token's granted scopes — the ceiling. */
  scopes: readonly string[];

  /**
   * The scope this action requires; the bearer's {@link scopes} must include it. This
   * is the ceiling that makes a read-scoped token unable to reach a write, independent
   * of how privileged the subject is.
   */
  requiredScope: string;

  /** The subject's roles — the input to the policy floor. */
  roles: Iterable<string>;

  /** The compiled policy — the live floor the subject's roles are checked against. */
  policy: Policy<string, string>;

  /** The permission this action needs; granted iff the subject's roles hold it. */
  permission: string;
}

/**
 * The RS authorization decision: the INTERSECTION of the token's scope ceiling and the
 * policy floor.
 *
 * An action is permitted iff BOTH hold: the bearer's granted scopes cover the scope the
 * action requires (the ceiling — a `mcp:read` token can never reach a write), AND the
 * subject's roles are granted the permission by the live policy (the floor). Either
 * alone is insufficient: a broadly-scoped token is still bounded by the subject's roles,
 * and a privileged subject is still bounded by the token's scope. The ceiling is checked
 * first, so a scope-insufficient call never consults the policy.
 */
export function authorizeBearer(request: BearerAuthorization): boolean {
  const { scopes, requiredScope, roles, policy, permission } = request;

  // Ceiling: the token's scopes must include what the action requires.
  if (!scopes.includes(requiredScope)) return false;

  // Floor: the subject's roles must be granted the permission by the policy.
  return policy.allows(roles, permission);
}
