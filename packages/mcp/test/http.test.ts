import { describe, expect, it, vi } from "vitest";

import { definePolicy } from "@lesto/authz";

import {
  authorizeBearer,
  bearerFromAuthorization,
  createBearerAuthenticator,
  protectedResourceMetadata,
} from "../src/http";
import type { AccessTokenClaims } from "../src/http";

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

  it("refuses a token minted for another audience — no passthrough (string aud)", async () => {
    const authenticate = createBearerAuthenticator({
      verifyAccessToken: async () => ({ ...ownClaims, audience: "https://other.test/mcp" }),
      resource: RESOURCE,
      rolesOf: async () => ["operator"],
    });

    expect(await authenticate("cross.audience.token")).toBeUndefined();
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
