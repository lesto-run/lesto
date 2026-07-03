import { describe, expect, it, vi } from "vitest";

import { definePolicy } from "@lesto/authz";

import {
  authorizeBearer,
  bearerChallenge,
  bearerFromAuthorization,
  createBearerAuthenticator,
  gateMcpHttpRequest,
  insufficientScopeChallenge,
  isOriginAllowed,
  mcpModeForScopes,
  policyFloorChallenge,
  protectedResourceMetadata,
  refusalBody,
  scopeCeilingChallenge,
} from "../src/http";
import type { AccessTokenClaims, BearerSession, ToolRequirement } from "../src/http";

const PRM_URL = "https://api.example.test/.well-known/oauth-protected-resource";

// This RS's own identifier — the audience every accepted token must carry.
const RESOURCE = "https://api.example.test/mcp";

// A token the configured issuer minted for THIS resource: the happy-path claims.
const ownClaims: AccessTokenClaims = {
  subject: "user-42",
  audience: RESOURCE,
  scopes: ["mcp:read", "mcp:write"],
};

describe("bearerFromAuthorization", () => {
  it("extracts the token from a well-formed header", () => {
    expect(bearerFromAuthorization("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("matches the scheme case-insensitively and tolerates surrounding whitespace", () => {
    expect(bearerFromAuthorization("  bearer   abc.def.ghi  ")).toBe("abc.def.ghi");
  });

  it("returns undefined when the header is absent", () => {
    expect(bearerFromAuthorization(undefined)).toBeUndefined();
  });

  it("returns undefined for a non-bearer scheme", () => {
    expect(bearerFromAuthorization("Basic dXNlcjpwYXNz")).toBeUndefined();
  });

  it("returns undefined when the token is missing or malformed", () => {
    expect(bearerFromAuthorization("Bearer ")).toBeUndefined();
    expect(bearerFromAuthorization("Bearer a b")).toBeUndefined();
  });
});

describe("protectedResourceMetadata", () => {
  it("builds the RFC 9728 document, advertising the issuer and header-only bearer", () => {
    const metadata = protectedResourceMetadata({
      resource: RESOURCE,
      authorizationServers: ["https://issuer.example.test"],
    });

    expect(metadata).toEqual({
      resource: RESOURCE,
      authorization_servers: ["https://issuer.example.test"],
      bearer_methods_supported: ["header"],
    });
  });

  it("advertises scopes_supported only when a vocabulary is declared", () => {
    const metadata = protectedResourceMetadata({
      resource: RESOURCE,
      authorizationServers: ["https://issuer.example.test"],
      scopesSupported: ["mcp:read", "mcp:write"],
    });

    expect(metadata.scopes_supported).toEqual(["mcp:read", "mcp:write"]);
  });

  it("omits scopes_supported entirely when unset (not an explicit undefined)", () => {
    const metadata = protectedResourceMetadata({
      resource: RESOURCE,
      authorizationServers: ["https://issuer.example.test"],
    });

    expect("scopes_supported" in metadata).toBe(false);
  });
});

describe("createBearerAuthenticator", () => {
  it("binds a valid, own-audience token's subject to a principal with its roles + scopes", async () => {
    const verifyAccessToken = vi.fn(async () => ownClaims);
    const rolesOf = vi.fn(async () => ["operator"]);

    const authenticate = createBearerAuthenticator({
      verifyAccessToken,
      resource: RESOURCE,
      rolesOf,
    });

    const session = await authenticate("a.token");

    expect(session).toEqual({
      principal: { actor: "user-42", actorRoles: ["operator"] },
      scopes: ["mcp:read", "mcp:write"],
    });
    // The seam saw the raw token; the subject — not the token — keyed the roles lookup.
    expect(verifyAccessToken).toHaveBeenCalledWith("a.token");
    expect(rolesOf).toHaveBeenCalledWith("user-42");
  });

  it("accepts a token whose audience is an array that includes this resource", async () => {
    const authenticate = createBearerAuthenticator({
      verifyAccessToken: async () => ({
        ...ownClaims,
        audience: ["https://other.test", RESOURCE],
      }),
      resource: RESOURCE,
      rolesOf: async () => ["operator"],
    });

    const session = await authenticate("a.token");

    expect(session?.principal.actor).toBe("user-42");
  });

  it("attributes an authenticated subject with no roles, but with empty roles", async () => {
    const authenticate = createBearerAuthenticator({
      verifyAccessToken: async () => ownClaims,
      resource: RESOURCE,
      rolesOf: async () => [],
    });

    const session = await authenticate("a.token");

    expect(session?.principal).toEqual({ actor: "user-42", actorRoles: [] });
  });

  it("refuses an invalid/expired token (the seam returned undefined) without resolving roles", async () => {
    const rolesOf = vi.fn(async () => ["operator"]);

    const authenticate = createBearerAuthenticator({
      verifyAccessToken: async () => undefined,
      resource: RESOURCE,
      rolesOf,
    });

    expect(await authenticate("bad.token")).toBeUndefined();
    expect(rolesOf).not.toHaveBeenCalled();
  });

  it("refuses a cross-audience token without resolving roles — no passthrough (string aud)", async () => {
    const rolesOf = vi.fn(async () => ["operator"]);

    const authenticate = createBearerAuthenticator({
      verifyAccessToken: async () => ({ ...ownClaims, audience: "https://other.test/mcp" }),
      resource: RESOURCE,
      rolesOf,
    });

    expect(await authenticate("cross.audience.token")).toBeUndefined();
    // A token we're about to refuse never triggers a roles lookup.
    expect(rolesOf).not.toHaveBeenCalled();
  });

  it("refuses a token whose audience array omits this resource", async () => {
    const authenticate = createBearerAuthenticator({
      verifyAccessToken: async () => ({
        ...ownClaims,
        audience: ["https://other.test", "https://elsewhere.test"],
      }),
      resource: RESOURCE,
      rolesOf: async () => ["operator"],
    });

    expect(await authenticate("cross.audience.token")).toBeUndefined();
  });

  it("refuses a token carrying an empty audience array (fail-closed)", async () => {
    const authenticate = createBearerAuthenticator({
      verifyAccessToken: async () => ({ ...ownClaims, audience: [] }),
      resource: RESOURCE,
      rolesOf: async () => ["operator"],
    });

    expect(await authenticate("no.audience.token")).toBeUndefined();
  });

  it("composes synchronous seams too (MaybePromise, not just async)", async () => {
    const authenticate = createBearerAuthenticator({
      verifyAccessToken: () => ownClaims,
      resource: RESOURCE,
      rolesOf: () => ["operator"],
    });

    const session = await authenticate("a.token");

    expect(session).toEqual({
      principal: { actor: "user-42", actorRoles: ["operator"] },
      scopes: ["mcp:read", "mcp:write"],
    });
  });

  it("refuses to build against an empty resource — the audience guard would be vacuous", () => {
    expect(() =>
      createBearerAuthenticator({
        verifyAccessToken: async () => ownClaims,
        resource: "",
        rolesOf: async () => ["operator"],
      }),
    ).toThrow(/non-empty `resource`/);
  });
});

describe("authorizeBearer", () => {
  // A minimal policy: the operator role may write; everyone reads.
  const policy = definePolicy({
    roles: ["reader", "operator"],
    can: {
      "mcp.read": ["reader", "operator"],
      "mcp.write": ["operator"],
    },
  });

  it("permits an action when scope ceiling AND policy floor both hold", () => {
    expect(
      authorizeBearer({
        scopes: ["mcp:write"],
        requiredScope: "mcp:write",
        roles: ["operator"],
        policy,
        permission: "mcp.write",
      }),
    ).toBe(true);
  });

  it("refuses when the policy denies, even with sufficient scope (the floor)", () => {
    expect(
      authorizeBearer({
        scopes: ["mcp:write"],
        requiredScope: "mcp:write",
        roles: ["reader"],
        policy,
        permission: "mcp.write",
      }),
    ).toBe(false);
  });

  it("refuses when the scope is missing, even when the policy allows (the ceiling)", () => {
    // A read-scoped token held by a full operator still cannot reach a write.
    expect(
      authorizeBearer({
        scopes: ["mcp:read"],
        requiredScope: "mcp:write",
        roles: ["operator"],
        policy,
        permission: "mcp.write",
      }),
    ).toBe(false);
  });
});

describe("mcpModeForScopes", () => {
  it("unlocks operator mode when the write scope is present", () => {
    expect(mcpModeForScopes(["mcp:read", "mcp:write"], { writeScope: "mcp:write" })).toBe(
      "operator",
    );
  });

  it("floors a narrower token to read-only — a read token can never write", () => {
    expect(mcpModeForScopes(["mcp:read"], { writeScope: "mcp:write" })).toBe("read-only");
    expect(mcpModeForScopes([], { writeScope: "mcp:write" })).toBe("read-only");
  });
});

describe("isOriginAllowed", () => {
  const allowed = ["https://app.example.test"];

  it("allows a present origin on the allowlist", () => {
    expect(isOriginAllowed("https://app.example.test", allowed)).toBe(true);
  });

  it("refuses a present origin off the allowlist (DNS-rebinding guard)", () => {
    expect(isOriginAllowed("https://evil.test", allowed)).toBe(false);
  });

  it("allows an absent origin — a non-browser client carries no rebinding risk", () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
  });
});

describe("bearerChallenge", () => {
  it("points an unauthenticated request at the protected-resource metadata", () => {
    expect(bearerChallenge({ resourceMetadata: PRM_URL })).toBe(
      `Bearer resource_metadata="${PRM_URL}"`,
    );
  });

  it("marks a presented-but-invalid token with error=invalid_token", () => {
    expect(bearerChallenge({ resourceMetadata: PRM_URL, invalidToken: true })).toBe(
      `Bearer error="invalid_token", resource_metadata="${PRM_URL}"`,
    );
  });
});

describe("insufficientScopeChallenge", () => {
  it("names the required permission as the scope, for the client to display", () => {
    expect(insufficientScopeChallenge({ scope: "mcp:write" })).toBe(
      `Bearer error="insufficient_scope", scope="mcp:write"`,
    );
  });

  it("includes the resource metadata when known, and escapes quoted-string specials", () => {
    expect(insufficientScopeChallenge({ scope: 'a"b', resourceMetadata: PRM_URL })).toBe(
      `Bearer error="insufficient_scope", scope="a\\"b", resource_metadata="${PRM_URL}"`,
    );
  });
});

describe("gateMcpHttpRequest", () => {
  const operatorSession: BearerSession = {
    principal: { actor: "user-42", actorRoles: ["operator"] },
    scopes: ["mcp:read", "mcp:write"],
  };

  const base = {
    allowedOrigins: ["https://app.example.test"],
    resourceMetadata: PRM_URL,
    writeScope: "mcp:write",
  };

  it("refuses a cross-site origin with 403 and no challenge — before reading any token", async () => {
    const authenticate = vi.fn(async () => operatorSession);

    const decision = await gateMcpHttpRequest({
      ...base,
      origin: "https://evil.test",
      authorization: "Bearer good.token",
      authenticate,
    });

    expect(decision).toEqual({
      kind: "reject",
      status: 403,
      body: JSON.stringify({
        error: "access_denied",
        error_description: "Cross-site origin not allowed (the DNS-rebinding guard).",
      }),
    });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("answers a missing token with a bare 401 pointing at the metadata", async () => {
    const decision = await gateMcpHttpRequest({
      ...base,
      origin: undefined,
      authorization: undefined,
      authenticate: async () => operatorSession,
    });

    expect(decision).toEqual({
      kind: "reject",
      status: 401,
      wwwAuthenticate: `Bearer resource_metadata="${PRM_URL}"`,
      body: JSON.stringify({
        error: "invalid_request",
        error_description: "Authorization required: present a Bearer access token.",
        resource_metadata: PRM_URL,
      }),
    });
  });

  it("marks a presented-but-invalid token 401 invalid_token", async () => {
    const decision = await gateMcpHttpRequest({
      ...base,
      origin: "https://app.example.test",
      authorization: "Bearer bad.token",
      authenticate: async () => undefined,
    });

    expect(decision).toEqual({
      kind: "reject",
      status: 401,
      wwwAuthenticate: `Bearer error="invalid_token", resource_metadata="${PRM_URL}"`,
      body: JSON.stringify({
        error: "invalid_token",
        error_description: "The access token is invalid or expired.",
        resource_metadata: PRM_URL,
      }),
    });
  });

  it("accepts a write-scoped token and unlocks operator mode", async () => {
    const decision = await gateMcpHttpRequest({
      ...base,
      origin: "https://app.example.test",
      authorization: "Bearer good.token",
      authenticate: async () => operatorSession,
    });

    expect(decision).toEqual({ kind: "accept", session: operatorSession, mode: "operator" });
  });

  it("accepts a read-only token and floors the mode to read-only", async () => {
    const readSession: BearerSession = {
      principal: { actor: "user-9", actorRoles: ["viewer"] },
      scopes: ["mcp:read"],
    };

    const decision = await gateMcpHttpRequest({
      ...base,
      origin: undefined,
      authorization: "Bearer read.token",
      authenticate: async () => readSession,
    });

    expect(decision).toEqual({ kind: "accept", session: readSession, mode: "read-only" });
  });
});

describe("scopeCeilingChallenge", () => {
  const destructiveTools = new Set(["handle_request", "create_content_entry"]);
  const opts = { destructiveTools, writeScope: "mcp:write" };

  it("never fires in operator mode (the write scope was present)", () => {
    expect(
      scopeCeilingChallenge({
        ...opts,
        mode: "operator",
        message: { method: "tools/call", params: { name: "handle_request" } },
      }),
    ).toBeUndefined();
  });

  it("refuses a destructive tools/call under read-only with an insufficient_scope challenge", () => {
    expect(
      scopeCeilingChallenge({
        ...opts,
        mode: "read-only",
        message: { method: "tools/call", params: { name: "handle_request" } },
      }),
    ).toEqual({
      wwwAuthenticate: `Bearer error="insufficient_scope", scope="mcp:write"`,
      body: JSON.stringify({
        error: "insufficient_scope",
        error_description: "This tool requires a broader token scope.",
        scope: "mcp:write",
      }),
    });
  });

  it("lets a non-destructive tools/call through under read-only", () => {
    expect(
      scopeCeilingChallenge({
        ...opts,
        mode: "read-only",
        message: { method: "tools/call", params: { name: "list_routes" } },
      }),
    ).toBeUndefined();
  });

  it("ignores non-tools/call messages (a list, the initialize handshake)", () => {
    expect(
      scopeCeilingChallenge({ ...opts, mode: "read-only", message: { method: "tools/list" } }),
    ).toBeUndefined();
  });

  it("ignores a non-object body and a call with a non-string tool name", () => {
    expect(scopeCeilingChallenge({ ...opts, mode: "read-only", message: null })).toBeUndefined();
    expect(
      scopeCeilingChallenge({
        ...opts,
        mode: "read-only",
        message: { method: "tools/call", params: { name: 7 } },
      }),
    ).toBeUndefined();
  });

  it("refuses a destructive tools/call wrapped in a JSON-RPC batch array — no slip-through", () => {
    expect(
      scopeCeilingChallenge({
        ...opts,
        mode: "read-only",
        message: [{ method: "tools/call", params: { name: "handle_request" } }],
      }),
    ).toEqual({
      wwwAuthenticate: `Bearer error="insufficient_scope", scope="mcp:write"`,
      body: JSON.stringify({
        error: "insufficient_scope",
        error_description: "This tool requires a broader token scope.",
        scope: "mcp:write",
      }),
    });
  });

  it("lets a batch of only reads through under read-only", () => {
    expect(
      scopeCeilingChallenge({
        ...opts,
        mode: "read-only",
        message: [
          { method: "tools/list" },
          { method: "tools/call", params: { name: "list_routes" } },
        ],
      }),
    ).toBeUndefined();
  });
});

/** A one-shot generator of the operator role — proves the floor materializes roles once. */
function* operatorRoleOnce(): Generator<string> {
  yield "operator";
}

describe("policyFloorChallenge (OCP-7)", () => {
  // The operator role may write; everyone reads. The floor is checked against the SUBJECT's
  // roles, independent of the token's scopes.
  const policy = definePolicy({
    roles: ["viewer", "operator"],
    can: {
      "mcp.read": ["viewer", "operator"],
      "mcp.write": ["operator"],
    },
  });

  // `handle_request` needs the write scope AND the `mcp.write` permission; an unmapped tool
  // (e.g. `list_routes`) carries no floor.
  const requirements = new Map<string, ToolRequirement>([
    ["handle_request", { scope: "mcp:write", permission: "mcp.write" }],
  ]);

  const writeCall = { method: "tools/call", params: { name: "handle_request" } };

  it("lets a mapped destructive call through when scope ceiling AND policy floor both hold", () => {
    expect(
      policyFloorChallenge({
        message: writeCall,
        scopes: ["mcp:read", "mcp:write"],
        roles: ["operator"],
        policy,
        requirements,
      }),
    ).toBeUndefined();
  });

  it("refuses a mapped call when the subject's roles lack the permission — even with the write scope (the floor)", () => {
    // A write-scoped token held by a mere viewer: operator mode is reached, but the policy denies.
    expect(
      policyFloorChallenge({
        message: writeCall,
        scopes: ["mcp:read", "mcp:write"],
        roles: ["viewer"],
        policy,
        requirements,
      }),
    ).toEqual({
      wwwAuthenticate: `Bearer error="insufficient_scope", scope="mcp.write"`,
      body: JSON.stringify({
        error: "insufficient_scope",
        error_description: "Your roles are not granted the permission this tool requires.",
        scope: "mcp.write",
      }),
    });
  });

  it("refuses a mapped call when the scope is missing, even when the roles allow (the ceiling)", () => {
    expect(
      policyFloorChallenge({
        message: writeCall,
        scopes: ["mcp:read"],
        roles: ["operator"],
        policy,
        requirements,
      }),
    ).toEqual({
      wwwAuthenticate: `Bearer error="insufficient_scope", scope="mcp.write"`,
      body: JSON.stringify({
        error: "insufficient_scope",
        error_description: "Your roles are not granted the permission this tool requires.",
        scope: "mcp.write",
      }),
    });
  });

  it("includes the resource metadata in the challenge when known", () => {
    expect(
      policyFloorChallenge({
        message: writeCall,
        scopes: ["mcp:write"],
        roles: ["viewer"],
        policy,
        requirements,
        resourceMetadata: PRM_URL,
      }),
    ).toEqual({
      wwwAuthenticate: `Bearer error="insufficient_scope", scope="mcp.write", resource_metadata="${PRM_URL}"`,
      body: JSON.stringify({
        error: "insufficient_scope",
        error_description: "Your roles are not granted the permission this tool requires.",
        scope: "mcp.write",
        resource_metadata: PRM_URL,
      }),
    });
  });

  it("is a no-op when no policy is configured — the back-compatible default (scope ceiling only)", () => {
    // A viewer calling a write: with no policy the floor never fires, so the scope ceiling stays
    // the sole gate — exactly the pre-OCP-7 behavior.
    expect(
      policyFloorChallenge({
        message: writeCall,
        scopes: ["mcp:write"],
        roles: ["viewer"],
        policy: undefined,
        requirements,
      }),
    ).toBeUndefined();
  });

  it("carries no floor for a tool absent from the requirements map (the ceiling governs it)", () => {
    expect(
      policyFloorChallenge({
        message: { method: "tools/call", params: { name: "list_routes" } },
        scopes: ["mcp:read"],
        roles: ["viewer"],
        policy,
        requirements,
      }),
    ).toBeUndefined();
  });

  it("ignores non-tools/call messages (a list, the initialize handshake)", () => {
    expect(
      policyFloorChallenge({
        message: { method: "tools/list" },
        scopes: ["mcp:write"],
        roles: ["viewer"],
        policy,
        requirements,
      }),
    ).toBeUndefined();
  });

  it("refuses the first denied mapped call in a JSON-RPC batch — no slip-through", () => {
    expect(
      policyFloorChallenge({
        message: [{ method: "tools/call", params: { name: "list_routes" } }, writeCall],
        scopes: ["mcp:write"],
        roles: ["viewer"],
        policy,
        requirements,
      }),
    ).toEqual({
      wwwAuthenticate: `Bearer error="insufficient_scope", scope="mcp.write"`,
      body: JSON.stringify({
        error: "insufficient_scope",
        error_description: "Your roles are not granted the permission this tool requires.",
        scope: "mcp.write",
      }),
    });
  });

  it("materializes the roles once so every tool in a batch is checked against them (no drained iterator)", () => {
    // A one-shot generator would be exhausted by the first mapped call, leaving the second
    // checked against empty roles. The floor must see the operator role for BOTH writes.
    expect(
      policyFloorChallenge({
        message: [writeCall, writeCall],
        scopes: ["mcp:write"],
        roles: operatorRoleOnce(),
        policy,
        requirements,
      }),
    ).toBeUndefined();
  });
});

describe("refusalBody", () => {
  it("serializes the OAuth error + description, omitting an absent scope and metadata", () => {
    expect(
      refusalBody({ error: "invalid_token", description: "The access token is invalid." }),
    ).toBe(
      JSON.stringify({ error: "invalid_token", error_description: "The access token is invalid." }),
    );
  });

  it("includes the scope and resource_metadata when given", () => {
    expect(
      refusalBody({
        error: "insufficient_scope",
        description: "needs the write scope",
        scope: "mcp:write",
        resourceMetadata: PRM_URL,
      }),
    ).toBe(
      JSON.stringify({
        error: "insufficient_scope",
        error_description: "needs the write scope",
        scope: "mcp:write",
        resource_metadata: PRM_URL,
      }),
    );
  });
});
