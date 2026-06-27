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
 *   - **Authorize.** {@link authorizeBearer} expresses the full INTERSECTION (scope
 *     ceiling AND policy floor). The transport always wires the scope ceiling, via
 *     {@link mcpModeForScopes} → the `dispatch` operator gate; when the deployment
 *     configures a {@link Policy} + per-tool requirements, {@link policyFloorChallenge}
 *     also wires the per-tool POLICY floor (OCP-7) at the HTTP gate, so within `operator`
 *     a destructive tool is reachable only by a subject whose roles the policy grants —
 *     not by any write-scoped bearer. With no policy configured the gate is a no-op, so
 *     the scope ceiling stays the sole gate (the back-compatible default).
 *
 * Plus the RFC 9728 Protected Resource Metadata ({@link protectedResourceMetadata})
 * a client reads from `.well-known/oauth-protected-resource` to discover where to get
 * a token.
 */

import type { Policy, Principal } from "@lesto/authz";

import { McpError } from "./errors";
import type { McpMode } from "./tools";

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
   * do (a `mcp:read` token can never reach a write). The seam MUST hand back the
   * already-split scope tokens, NOT the raw space-delimited `scope` string (RFC 6749
   * §3.3): the ceiling is an exact-membership check, so a single un-split
   * `["mcp:read mcp:write"]` element would silently match nothing and deny everything.
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
 * The scheme is matched case-insensitively (RFC 6750 §2.1), and the captured token is
 * constrained to the spec's `b64token` grammar (`ALPHA / DIGIT / "-._~+/" / "="`) — so a
 * malformed credential is rejected at this boundary rather than handed on to the verify
 * seam. The transport reads the bearer from the `Authorization` header ONLY — never a
 * query string, where it would leak into logs and referrers — so this parser is the sole
 * entry point for a token.
 */
export function bearerFromAuthorization(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;

  const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim());

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
  /**
   * This RS's own resource identifier — the audience tokens must carry. The canonical
   * resource URI, byte-identical to the `resource` the authenticator checks against and
   * to the `aud` the issuer mints.
   */
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
   * different service can never be replayed here (the confused-deputy guard). MUST be
   * the canonical resource URI, byte-identical to the `aud` value the issuer mints
   * (audience comparison is exact per RFC 7519 §4.1.3 — no trailing-slash/port/case
   * normalization is applied here), and non-empty (an empty resource would make the
   * guard vacuous; {@link createBearerAuthenticator} rejects it at construction).
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

  // A blank resource would make the audience guard vacuous — `"" === ""` and
  // `[""].includes("")` both hold — so a token audienced to nothing would slip
  // through. Refuse it loudly at construction rather than silently honoring such
  // tokens at request time (a misconfig that otherwise reads as "every token valid").
  if (resource === "") {
    throw new McpError(
      "MCP_RESOURCE_REQUIRED",
      "An MCP Resource Server needs a non-empty `resource` identifier to check token audiences against.",
    );
  }

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

/**
 * Map a token's scopes to the MCP mode they unlock — the scope ceiling expressed through
 * the existing read-only/operator gate ({@link McpMode}).
 *
 * A token carrying the write scope unlocks `operator`, so the destructive tools become
 * reachable; any narrower token gets the `read-only` floor, so a read-scoped bearer can
 * never drive a write no matter how privileged its subject. The write-scope name is
 * injected — the OAuth scope vocabulary belongs to the deployment, not this package.
 *
 * NOTE: this is the scope CEILING only. The per-tool POLICY floor (`policy.allows(roles, …)`
 * via {@link authorizeBearer}) is a SEPARATE, complementary gate: {@link policyFloorChallenge}
 * wires it at the HTTP layer (OCP-7) when a deployment configures a {@link Policy}. With a
 * policy configured, `operator` mode is necessary but no longer sufficient — a destructive
 * tool is reachable only by a subject the policy also grants the tool's permission. With no
 * policy configured (the back-compatible default) a write scope is the only gate on a write.
 */
export function mcpModeForScopes(
  scopes: readonly string[],
  options: { writeScope: string },
): McpMode {
  return scopes.includes(options.writeScope) ? "operator" : "read-only";
}

/**
 * Is this request's `Origin` allowed — the DNS-rebinding guard?
 *
 * A browser attaches `Origin` to every cross-site request, so a malicious page in a
 * victim's browser could otherwise drive a local MCP server (DNS rebinding). A PRESENT
 * origin must therefore be on the allowlist. An ABSENT origin is a non-browser client
 * (the agent's own HTTP call, curl) and carries no rebinding risk — the threat is a
 * browser forging cross-site requests, which always sends an `Origin` — so it is allowed.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  return origin === undefined || allowedOrigins.includes(origin);
}

/** Escape a value for an RFC 7235 quoted-string (`\` and `"` become quoted-pairs). */
function quoteParam(value: string): string {
  return value.replace(/[\\"]/g, (char) => `\\${char}`);
}

/**
 * Render a `Bearer` challenge from its quoted parameters, dropping the absent ones.
 * Every caller supplies at least one parameter (a 401 always carries `resource_metadata`,
 * a 403 always carries `error`+`scope`), so the rendered list is never empty.
 */
function bearerChallengeFrom(params: Record<string, string | undefined>): string {
  const rendered = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}="${quoteParam(value)}"`);

  return `Bearer ${rendered.join(", ")}`;
}

/**
 * The `WWW-Authenticate` value for a `401` — an unauthenticated or invalid-token request.
 *
 * Always points the client at this RS's Protected Resource Metadata (RFC 9728 §5.1) so it
 * can discover where to obtain a token. When a token WAS presented but failed validation,
 * `invalidToken` adds `error="invalid_token"` (RFC 6750 §3) — distinguishing "no token"
 * from "bad token" to the client without leaking *why* the token was rejected.
 */
export function bearerChallenge(options: {
  resourceMetadata: string;
  invalidToken?: boolean;
}): string {
  return bearerChallengeFrom({
    error: options.invalidToken === true ? "invalid_token" : undefined,
    resource_metadata: options.resourceMetadata,
  });
}

/**
 * The `WWW-Authenticate` value for a `403` — an authenticated caller whose token scope
 * does not clear the requested action (RFC 6750 §3.1).
 *
 * `scope` names the permission/scope the action required, for the client to surface or
 * step up to; `resourceMetadata` is included when known so the client can re-discover the
 * issuer.
 */
export function insufficientScopeChallenge(options: {
  scope: string;
  resourceMetadata?: string;
}): string {
  return bearerChallengeFrom({
    error: "insufficient_scope",
    scope: options.scope,
    resource_metadata: options.resourceMetadata,
  });
}

/** The RS's verdict on an inbound HTTP request, before any tool runs. */
export type McpHttpGateDecision =
  | {
      /** Refuse the request at the HTTP layer with this status (+ challenge, on a 401). */
      kind: "reject";
      status: number;
      wwwAuthenticate?: string;
    }
  | {
      /** Proceed: the authenticated session + the {@link McpMode} its scopes unlock. */
      kind: "accept";
      session: BearerSession;
      mode: McpMode;
    };

/** What {@link gateMcpHttpRequest} needs to decide an inbound request. */
export interface McpHttpGateOptions {
  /** The request's `Origin` header (absent for a non-browser client). */
  origin: string | undefined;

  /** The request's `Authorization` header value. */
  authorization: string | undefined;

  /** The browser origins allowed to reach this server (the DNS-rebinding allowlist). */
  allowedOrigins: readonly string[];

  /** Validate a bearer and bind it to a session — a {@link createBearerAuthenticator}. */
  authenticate: (token: string) => Promise<BearerSession | undefined>;

  /** This RS's Protected Resource Metadata URL, for the `WWW-Authenticate` pointer. */
  resourceMetadata: string;

  /** The OAuth scope that unlocks writes — the ceiling {@link mcpModeForScopes} reads. */
  writeScope: string;
}

/**
 * The RS's request-level gate (ADR 0028 Phase 3b): `Origin` guard → bearer authentication
 * → scope-derived {@link McpMode}.
 *
 * Returns a `reject` carrying the spec-shaped status (and, on a 401, the
 * `WWW-Authenticate` challenge) the transport renders into an HTTP error, or an `accept`
 * carrying the authenticated {@link BearerSession} and the mode its scopes unlock. The
 * ordering is deliberate: a cross-site origin is refused (`403`, no challenge — it is not
 * an auth problem) before any token is read; a missing token is a bare `401` pointing at
 * the metadata; a presented-but-invalid token is a `401` marked `invalid_token`. The
 * per-tool scope ceiling ({@link scopeCeilingChallenge}) and the per-tool policy floor
 * ({@link policyFloorChallenge}, when a policy is configured) both apply later, against the
 * accepted session.
 */
export async function gateMcpHttpRequest(
  options: McpHttpGateOptions,
): Promise<McpHttpGateDecision> {
  if (!isOriginAllowed(options.origin, options.allowedOrigins)) {
    return { kind: "reject", status: 403 };
  }

  const token = bearerFromAuthorization(options.authorization);

  if (token === undefined) {
    return {
      kind: "reject",
      status: 401,
      wwwAuthenticate: bearerChallenge({ resourceMetadata: options.resourceMetadata }),
    };
  }

  const session = await options.authenticate(token);

  if (session === undefined) {
    return {
      kind: "reject",
      status: 401,
      wwwAuthenticate: bearerChallenge({
        resourceMetadata: options.resourceMetadata,
        invalidToken: true,
      }),
    };
  }

  return {
    kind: "accept",
    session,
    mode: mcpModeForScopes(session.scopes, { writeScope: options.writeScope }),
  };
}

/** A minimal view of a JSON-RPC `tools/call` — the only message the scope ceiling inspects. */
interface ToolsCallMessage {
  method?: unknown;
  params?: { name?: unknown };
}

/** Narrow a single JSON-RPC message to a `tools/call`, returning the tool name or `undefined`. */
function toolsCallName(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;

  const candidate = message as ToolsCallMessage;

  if (candidate.method !== "tools/call") return undefined;

  return typeof candidate.params?.name === "string" ? candidate.params.name : undefined;
}

/**
 * Every `tools/call` tool name in a JSON-RPC body — a single message OR a batch array.
 * The SDK transport processes a batch (`[msg, …]`) element-by-element, so the ceiling must
 * see inside it too, or a one-element batch would slip the check.
 */
function toolsCallNames(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];

  return messages.flatMap((message) => {
    const name = toolsCallName(message);

    return name === undefined ? [] : [name];
  });
}

/**
 * The scope-ceiling refusal for a tool call — or `undefined` to let it through.
 *
 * A request whose scopes only unlock `read-only` mode may not call a destructive tool: the
 * transport turns the returned challenge into an HTTP `403` BEFORE dispatch, so a
 * scope-insufficient write is refused at the HTTP layer (RFC 6750 §3.1) rather than
 * surfacing as a JSON-RPC error inside a `200`. It inspects a `tools/call` — including each
 * element of a JSON-RPC batch array — and lets a `tools/list` or the `initialize` handshake
 * through. In `operator` mode (the write scope was present) it never fires.
 *
 * This is the scope CEILING only. It is also enforced in depth by `dispatch`'s
 * `requireOperator` gate (a destructive tool refuses outside `operator`), so a call the
 * peek misses is still refused — just as a coded JSON-RPC error rather than a clean `403`.
 * The per-tool POLICY floor (roles) is the complementary {@link policyFloorChallenge}, run
 * right after this when a deployment configures a {@link Policy}.
 */
export function scopeCeilingChallenge(options: {
  message: unknown;
  mode: McpMode;
  destructiveTools: ReadonlySet<string>;
  writeScope: string;
}): string | undefined {
  if (options.mode === "operator") return undefined;

  const callsDestructive = toolsCallNames(options.message).some((name) =>
    options.destructiveTools.has(name),
  );

  return callsDestructive ? insufficientScopeChallenge({ scope: options.writeScope }) : undefined;
}

/** The scope + permission a single tool demands — the per-tool half of the OCP-7 floor. */
export interface ToolRequirement {
  /**
   * The OAuth scope this tool needs — the per-tool ceiling {@link authorizeBearer} checks
   * before the policy. For a destructive tool this is the deployment's write scope; the same
   * value {@link mcpModeForScopes} reads, restated per tool so the intersection is exact.
   */
  scope: string;

  /** The policy permission this tool needs — the floor the subject's roles are checked against. */
  permission: string;
}

/**
 * The policy-floor refusal for a tool call — or `undefined` to let it through (OCP-7).
 *
 * The complement to {@link scopeCeilingChallenge}: where the ceiling asks "does the TOKEN
 * carry the write scope?", the floor asks "do the SUBJECT's roles hold this tool's
 * permission?". A deployment opts in by configuring a compiled {@link Policy} plus a
 * `requirements` map (tool name → its {@link ToolRequirement}); each `tools/call` whose tool
 * names a requirement is run through {@link authorizeBearer}, the full INTERSECTION of scope
 * ceiling and policy floor. The first call the intersection denies yields a `403` challenge
 * naming the missing permission — refused at the HTTP layer BEFORE dispatch, like the ceiling.
 *
 * Fail-OPEN by configuration, fail-CLOSED by data: with no `policy` (the back-compatible
 * default) the floor is a no-op and the scope ceiling stays the sole gate; WITH a policy, a
 * tool that names a requirement is gated, and a subject whose roles the policy does not grant
 * is refused even in `operator` mode. A `tools/call` whose tool is absent from `requirements`
 * carries no policy floor — it is governed by the scope ceiling alone — so a deployment grants
 * a floor exactly to the tools it maps (typically the destructive ones).
 *
 * Like the ceiling it inspects a `tools/call` (including each element of a JSON-RPC batch) and
 * lets `tools/list` / `initialize` through. The roles are the authenticated subject's
 * ({@link BearerSession.principal}'s `actorRoles`); empty roles satisfy no permission, so an
 * attributed-but-unprivileged subject is denied.
 */
export function policyFloorChallenge(options: {
  message: unknown;
  scopes: readonly string[];
  roles: Iterable<string>;
  policy: Policy<string, string> | undefined;
  requirements: ReadonlyMap<string, ToolRequirement>;
  resourceMetadata?: string;
}): string | undefined {
  // No policy configured → the floor is off; the scope ceiling is the only gate (back-compat).
  if (options.policy === undefined) return undefined;

  const { policy } = options;

  // `authorizeBearer` reads `roles` as an `Iterable`; a one-shot iterator would be drained by
  // the first tool in a batch, so materialize the roles once for every per-tool check.
  const roles = [...options.roles];

  for (const name of toolsCallNames(options.message)) {
    const requirement = options.requirements.get(name);

    // A tool with no mapped requirement carries no policy floor — the ceiling governs it.
    if (requirement === undefined) continue;

    const permitted = authorizeBearer({
      scopes: options.scopes,
      requiredScope: requirement.scope,
      roles,
      policy,
      permission: requirement.permission,
    });

    if (!permitted) {
      // Name the permission the action required, for the client to surface or step up to.
      return insufficientScopeChallenge({
        scope: requirement.permission,
        ...(options.resourceMetadata === undefined
          ? {}
          : { resourceMetadata: options.resourceMetadata }),
      });
    }
  }

  return undefined;
}
