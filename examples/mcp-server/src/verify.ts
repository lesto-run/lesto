/**
 * The production token-validation seam: a {@link VerifyAccessToken} over a JWKS (jose).
 *
 * `@lesto/mcp` does NO JWKS/`jose` verification itself and takes no issuer dependency
 * (ADR 0028 Phase 3b) — it INJECTS this seam. This is the implementation a deployment
 * supplies: validate the JWT's signature against the issuer's published keys, check the
 * issuer and expiry, and surface the claims the RS authorizer needs (subject, audience,
 * scopes). It is AS-agnostic — the same function validates the demo IdP's tokens and a
 * real Auth0/Okta tenant's, the only difference being where the keys come from.
 *
 * **Local vs remote keys.** Pass a {@link JSONWebKeySet} (the demo's in-process JWKS) and
 * verification runs against an in-memory key set; pass a `URL` (your IdP's `jwks_uri`) and
 * `jose` fetches + caches the keys, so verification is OFFLINE on the hot path after the
 * first fetch and authentication never blocks on an issuer round-trip.
 *
 * **What this seam does NOT check: the audience.** Signature, issuer, and expiry are an
 * "is this a real, live token from a trusted issuer?" question and belong here. Whether the
 * token was minted for THIS resource (the no-passthrough / confused-deputy guard) is the
 * authenticator's job — `createBearerAuthenticator({ resource })` compares the `audience`
 * this seam returns against the RS's own identifier. Keeping the two apart is deliberate:
 * the verify seam stays reusable across resources, and the audience binding lives with the
 * resource that owns it.
 */

import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet, JWTPayload } from "jose";

import type { AccessTokenClaims, VerifyAccessToken } from "@lesto/mcp";

/** What {@link createJwksVerifier} needs to validate a token. */
export interface JwksVerifierOptions {
  /** The issuer (`iss`) to trust — tokens from any other issuer are rejected. */
  issuer: string;

  /**
   * The signing keys: an in-process {@link JSONWebKeySet} (the demo IdP's JWKS) or a `URL`
   * to the issuer's `jwks_uri` (production), which `jose` fetches and caches.
   */
  jwks: JSONWebKeySet | URL;
}

/**
 * OAuth carries granted scopes as a space-delimited `scope` string (RFC 6749 §3.3); some
 * issuers (Entra) use a `scp` array instead. Hand back the ALREADY-SPLIT tokens either
 * way — the RS scope ceiling is an exact-membership check, so a single unsplit
 * `"mcp:read mcp:write"` element would match nothing and deny everything.
 */
function scopesFrom(payload: JWTPayload): string[] {
  const scope = payload["scope"];
  if (typeof scope === "string") return scope.split(/\s+/u).filter((token) => token.length > 0);

  const scp = payload["scp"];
  if (Array.isArray(scp)) return scp.filter((token): token is string => typeof token === "string");

  return [];
}

/**
 * Build a {@link VerifyAccessToken} that validates a JWT access token against a JWKS.
 *
 * Returns the token's {@link AccessTokenClaims} when the signature, issuer, and expiry all
 * check out, or `undefined` for any token that is malformed, forged, expired, or from
 * another issuer — every one of which the RS maps to a `401`. It never throws: a rejected
 * token is `undefined`, not an exception, so a bad credential is an auth outcome rather
 * than a server error.
 */
export function createJwksVerifier(options: JwksVerifierOptions): VerifyAccessToken {
  // A `URL` is a remote `jwks_uri` (fetched + cached); a key set is the in-process demo JWKS.
  const keys =
    options.jwks instanceof URL
      ? createRemoteJWKSet(options.jwks)
      : createLocalJWKSet(options.jwks);

  return async (token: string): Promise<AccessTokenClaims | undefined> => {
    try {
      // Verify signature + issuer + expiry. NOT audience — that is the authenticator's
      // no-passthrough check against this resource (see the module note). `algorithms` pins
      // the accepted signature algorithm: jose already rejects `alg:none`/alg-confusion against
      // a JWKS, so this is belt-and-braces here — but it is the canonical JWT hardening and the
      // thing a single-key (non-JWKS) adaptation MUST set. A real deployment lists the
      // algorithm(s) its issuer signs with (e.g. `["RS256"]` or `["ES256"]`).
      const { payload } = await jwtVerify(token, keys, {
        issuer: options.issuer,
        algorithms: ["RS256"],
      });

      // A token with no string subject can't be attributed to a principal — refuse it.
      if (typeof payload.sub !== "string") return undefined;

      return {
        subject: payload.sub,
        // `aud` is absent, a string, or a string[] — pass it through for the audience guard.
        audience: payload.aud ?? [],
        scopes: scopesFrom(payload),
      };
    } catch {
      // Malformed, forged, expired, or wrong-issuer — an unauthenticated outcome, not an error.
      return undefined;
    }
  };
}
