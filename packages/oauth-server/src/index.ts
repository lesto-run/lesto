/**
 * @lesto/oauth-server — SKELETON (ADR 0041).
 *
 * The non-functional shape of open MCP client registration for the first-party OAuth
 * Authorization Server (ADR 0029): CIMD-first, with an RFC 7591 DCR compatibility path and
 * pre-registration as the locked-down third option. It encodes the contract — the
 * `resolveClient` seam, the `RegisteredClient` shape, the client-metadata document, the
 * registration config, the error codes — so the design is legible and typed before the
 * real build (ADR 0029 Phase 3) exists.
 *
 * This is NOT shippable DCR. Every resolver throws `OAUTH_NOT_IMPLEMENTED`: there is no
 * persistence, no crypto, no metadata fetch, no rate limiting, no `redirect_uri`
 * validation. Do NOT wire it to a live `/authorize` — the ADR 0041 D6 security posture and
 * ADR 0039 D5's single end-to-end security review must land first.
 */

export { notImplemented, OAuthServerError } from "./errors";
export type { OAuthServerErrorCode } from "./errors";

export {
  createClientResolver,
  looksLikeCimdClientId,
  lookupRegisteredClient,
  registerDynamicClient,
  resolveCimdClient,
} from "./registration";

export type {
  ClientMetadataDocument,
  RegisteredClient,
  RegistrationConfig,
  RegistrationSource,
  ResolveClient,
} from "./types";
