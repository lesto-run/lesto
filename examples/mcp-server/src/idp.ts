/**
 * A stand-in external IdP — the thing you DELETE in production.
 *
 * MA-6 ships an authenticated remote MCP server "with no crypto build": the
 * Resource Server validates a token from a *configured external IdP* (Auth0, Okta,
 * WorkOS, Entra) and never mints one itself. For the demo to be self-contained and
 * runnable — locally and in CI, with no tenant or network — this module plays the
 * IdP: it generates an RS256 keypair, publishes the matching JWKS, and signs JWTs
 * exactly the way a real issuer does.
 *
 * The verification path in {@link file://./verify.ts} is the *production* code — it
 * does real RS256 signature checking against a JWKS, real `iss`/`exp` validation. The
 * only thing this file fakes is *who the issuer is*. To go live you drop `idp.ts`,
 * point the verifier at your IdP's `jwks_uri` (a `URL`, so `createRemoteJWKSet`), and
 * change NOTHING else — the seam (ADR 0028 Phase 3b) makes the issuer a config swap.
 *
 * It mirrors how an OAuth IdP issues an *access token* for a resource: the JWT's `aud`
 * is the MCP server's resource identifier and its `scope` is a space-delimited string
 * (RFC 6749 §3.3) — `mcp:read` for a viewer, `mcp:read mcp:write` for an operator.
 */

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { JSONWebKeySet } from "jose";

/** The key id the issuer signs with and the JWKS advertises — how a verifier selects the key. */
const KEY_ID = "demo-key-1";

/** What an access token carries, as a caller asks this IdP to mint it. */
export interface IssueOptions {
  /** The token subject (`sub`) — the authenticated user id the RS attributes the call to. */
  subject: string;

  /** The space-delimited OAuth scope string (`"mcp:read mcp:write"`) — what the bearer may do. */
  scope: string;

  /** The audience (`aud`) the token is minted FOR — the RS's resource identifier. */
  audience: string;

  /** How long until the token expires; any `jose` duration (default `"5m"`). */
  expiresIn?: string;
}

/** A runnable stand-in for an external OAuth issuer (Auth0/Okta/…). */
export interface DemoIdp {
  /** The issuer identifier (`iss`) — what the RS trusts and advertises in its PRM. */
  issuer: string;

  /** The public JWKS a verifier reads to check signatures — the demo's `jwks_uri` body. */
  jwks: JSONWebKeySet;

  /** Mint a signed RS256 access token for the given subject/scope/audience. */
  issue(options: IssueOptions): Promise<string>;
}

/**
 * Stand up a demo issuer: generate a signing key, export its public half as a JWKS,
 * and hand back an `issue` that signs access tokens the way a real IdP would.
 *
 * The private key never leaves this closure — like a real IdP, only the public JWKS is
 * exposed, and the RS verifies against it.
 */
export async function createDemoIdp(options: { issuer: string }): Promise<DemoIdp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");

  // Publish the public key as a JWKS, tagged with the kid/alg/use a verifier selects on.
  const jwk = await exportJWK(publicKey);
  const jwks: JSONWebKeySet = { keys: [{ ...jwk, kid: KEY_ID, alg: "RS256", use: "sig" }] };

  return {
    issuer: options.issuer,
    jwks,
    issue: (issue) =>
      new SignJWT({ scope: issue.scope })
        .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
        .setIssuer(options.issuer)
        .setSubject(issue.subject)
        .setAudience(issue.audience)
        .setIssuedAt()
        .setExpirationTime(issue.expiresIn ?? "5m")
        .sign(privateKey),
  };
}
