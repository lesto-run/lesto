/**
 * The `VerifyAccessToken` seam, adapting a REAL OpenAuth-issued token to the RS contract.
 *
 * This is where the wedge pays off: `@lesto/mcp`'s RS governance
 * (`createBearerAuthenticator` → `createMcpHttpHandlers`) is UNCHANGED; the only issuer-
 * specific code is this adapter. OpenAuth's access token (confirmed against its source, not
 * docs) is an **ES256** JWT carrying `{ mode:"access", type:"user", properties, aud:<clientID>,
 * iss, sub, exp }` — there is no OAuth `scope` claim and `aud` is the client id, not a
 * resource. So this maps OpenAuth's shape onto the RS's `{ subject, audience, scopes }`:
 *
 *   - `subject`  ← `properties.userID` (the principal the RS attributes + audits)
 *   - `scopes`   ← `properties.scopes` (the grant's MCP scopes — the ceiling)
 *   - `audience` ← `aud` (the OpenAuth client id); the RS is configured with
 *                  `resource = <that client id>`, so a token minted for ANOTHER OpenAuth
 *                  client is refused (the confused-deputy guard still holds). OpenAuth 0.4.x
 *                  does not implement RFC 8707 resource indicators, so the client identity
 *                  IS the audience here; a production RS wanting per-resource audiences would
 *                  use an issuer that stamps the resource into `aud`.
 *
 * Verification itself is standard + offline: fetch + cache the issuer's JWKS, then check the
 * ES256 signature, issuer, and expiry. A bad token is `undefined` (a 401), never a throw.
 *
 * Why plain `jose` and NOT OpenAuth's `client.verify`: the RS must accept ANY JWKS issuer
 * (Auth0/Okta/OpenAuth) and take no issuer dependency — the whole point of the seam. OpenAuth's
 * `client.verify` is client-side code that additionally re-validates the subject *schema* (it
 * needs the issuer's `subjects` definition), which the RS neither owns nor needs: it reads only
 * the few claims the battery requires. So this adapter does the JWKS/signature check directly
 * and maps the claims — issuer-specific in WHAT it reads, standard in HOW it verifies.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

import type { AccessTokenClaims, VerifyAccessToken } from "@lesto/mcp";

/** What {@link createOpenAuthVerifier} needs to validate an OpenAuth token. */
export interface OpenAuthVerifierOptions {
  /** The issuer identifier (`iss`) — the OpenAuth Worker's URL. */
  issuer: string;

  /** The issuer's `jwks_uri` (from its discovery doc) — fetched + cached. */
  jwksUrl: URL;
}

/** The subject `properties` an OpenAuth token carries for this demo (see ../idp/subjects.ts). */
interface DemoProperties {
  userID?: unknown;
  scopes?: unknown;
}

/**
 * Build a {@link VerifyAccessToken} for OpenAuth-issued tokens. Returns the claims on a valid
 * ES256 token from the configured issuer, or `undefined` for anything malformed/forged/
 * expired/wrong-issuer — the RS maps that to a 401.
 */
export function createOpenAuthVerifier(options: OpenAuthVerifierOptions): VerifyAccessToken {
  const keys = createRemoteJWKSet(options.jwksUrl);

  return async (token: string): Promise<AccessTokenClaims | undefined> => {
    try {
      // Pin ES256 (OpenAuth's signing alg) + the issuer; expiry is checked by jose.
      const { payload } = await jwtVerify(token, keys, {
        issuer: options.issuer,
        algorithms: ["ES256"],
      });

      // Reject any non-access JWT the issuer signs. OpenAuth stamps `mode:"access"` on access
      // tokens (issuer.js) and its own `client.verify` checks this (client.js) — a refresh token
      // isn't even a JWT, but this stops any other/future token type being replayed as access.
      if (payload.mode !== "access") return undefined;

      const props = (payload.properties ?? {}) as DemoProperties;
      const subject = typeof props.userID === "string" ? props.userID : payload.sub;
      if (typeof subject !== "string") return undefined;

      return {
        subject,
        // OpenAuth's `aud` is the client id; the RS's `resource` is set to match.
        audience: payload.aud ?? [],
        // OpenAuth has no `scope` claim — the grant's scopes ride in `properties.scopes`.
        scopes: Array.isArray(props.scopes)
          ? props.scopes.filter((s): s is string => typeof s === "string")
          : [],
      };
    } catch {
      return undefined;
    }
  };
}
