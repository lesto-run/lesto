/**
 * Open MCP client registration — the shape (ADR 0041).
 *
 * SKELETON. Nothing here runs: every resolver is a `notImplemented` stub. What IS
 * captured is the *contract* — the `resolveClient` seam that keeps ADR 0029's `/authorize`
 * ignorant of registration, the three mechanisms behind it, and (in the doc-comments) the
 * validation flow each must implement. The dispatch decision (an `https:` URL ⇒ CIMD; an
 * opaque id ⇒ a store lookup) is the one load-bearing branch, so its *intent* is spelled
 * out, but the branch bodies are stubs until the ADR 0029 AS build (Phase 3) fills them.
 *
 * The seam mirrors ADR 0028's `VerifyAccessToken`: as the RS never learns the issuer
 * behind that seam, `/authorize` never learns the mechanism behind this one — both sides
 * see only a validated shape.
 */

import { notImplemented } from "./errors";
import type {
  ClientMetadataDocument,
  RegisteredClient,
  RegistrationConfig,
  ResolveClient,
} from "./types";

/**
 * True iff `clientId` is a CIMD identifier — an `https:` URL the client hosts its metadata
 * at — versus an opaque id minted by DCR or pre-registration. This is the dispatch the real
 * {@link resolveClient} will branch on; encoded here so the seam's shape is legible.
 *
 * SKELETON: the real predicate also enforces "no fragment" and the public-address SSRF
 * guard (ADR 0041 D6) *before* any fetch; this stub only states the branch.
 */
export function looksLikeCimdClientId(clientId: string): boolean {
  void clientId;

  return notImplemented("looksLikeCimdClientId");
}

/**
 * Resolve a CIMD client (ADR 0041 D2). The real flow:
 *   1. reject the `client_id` URL if not `https:`, has a fragment, or resolves private (SSRF guard);
 *   2. fetch over TLS with a hard timeout + max body + capped, re-guarded redirects;
 *   3. require the document's `client_id` to byte-equal the fetched URL;
 *   4. validate the {@link ClientMetadataDocument} shape (Zod, ADR 0005);
 *   5. derive a {@link RegisteredClient}, positive- AND negative-cache by URL.
 * No store, no write endpoint — CIMD has no registration-spam surface.
 */
export function resolveCimdClient(clientId: string): Promise<RegisteredClient> {
  void clientId;

  return notImplemented("resolveCimdClient");
}

/**
 * Register a client dynamically (RFC 7591 DCR — ADR 0041 D3). Off by default. The real flow:
 *   1. rate-limit hard, per-IP and global (the anti-spam control — the only writable surface);
 *   2. validate the {@link ClientMetadataDocument} with the SAME schema as CIMD;
 *   3. if a trust anchor is configured, require + verify a signed software statement (attested DCR);
 *   4. mint an opaque `client_id` and persist a {@link RegisteredClient} (`SqlDatabase`, ADR 0013);
 *   5. NEVER dereference a `redirect_uri` — store verbatim, exact-match only at `/authorize`.
 */
export function registerDynamicClient(
  document: ClientMetadataDocument,
  config: RegistrationConfig,
): Promise<RegisteredClient> {
  void document;
  void config;

  return notImplemented("registerDynamicClient");
}

/**
 * Look up a previously-persisted client by its minted/pre-shared id (the DCR-minted and
 * pre-registered cases — ADR 0041 D1). No fetch; a single `SqlDatabase` read.
 */
export function lookupRegisteredClient(clientId: string): Promise<RegisteredClient | undefined> {
  void clientId;

  return notImplemented("lookupRegisteredClient");
}

/**
 * The seam ADR 0029's `/authorize` uses to learn about a client — the ONLY path, for every
 * mechanism. Dispatches by shape: an `https:` URL ⇒ CIMD ({@link resolveCimdClient}); an
 * opaque id ⇒ a store lookup ({@link lookupRegisteredClient}, covering DCR-minted and
 * pre-registered ids). Returns the resolved {@link RegisteredClient} or `undefined`.
 *
 * SKELETON: returns a {@link ResolveClient} so callers can already type against the seam;
 * invoking it throws `OAUTH_NOT_IMPLEMENTED` until the ADR 0029 Phase 3 build lands.
 */
export function createClientResolver(_config: RegistrationConfig): ResolveClient {
  void _config;

  return (clientId: string) => notImplemented(`resolveClient(${clientId})`);
}
