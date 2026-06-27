/**
 * Errors carry codes, not just prose.
 *
 * Every failure in the (future) OAuth Authorization Server surfaces a stable,
 * machine-readable `code`. Clients, logs, and tests branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 *
 * SKELETON (ADR 0040): the only code wired today is {@link OAuthServerErrorCode}'s
 * `OAUTH_NOT_IMPLEMENTED`, thrown by every stub. The remaining codes are the contract
 * the real registration build (ADR 0029 Phase 3) will raise — declared up front so the
 * shape is legible and so callers can branch on them before the bodies exist.
 */

import { LestoError } from "@lesto/errors";

export type OAuthServerErrorCode =
  /** This is a non-functional skeleton — the body is not built yet (ADR 0040). */
  | "OAUTH_NOT_IMPLEMENTED"
  /** A `client_id` did not resolve to a registered client by any mechanism. */
  | "OAUTH_UNKNOWN_CLIENT"
  /** A client-metadata document (CIMD body or DCR request) failed shape validation. */
  | "OAUTH_INVALID_CLIENT_METADATA"
  /** A CIMD `client_id` URL was rejected before fetch (not https / has a fragment / private host). */
  | "OAUTH_CIMD_URL_REJECTED"
  /** The fetched CIMD document's `client_id` did not byte-equal the URL it was fetched from. */
  | "OAUTH_CIMD_IDENTITY_MISMATCH"
  /** Dynamic registration is disabled by config (the off-by-default posture, ADR 0040 D3). */
  | "OAUTH_DCR_DISABLED"
  /** A required, configured software statement was absent or failed verification (attested DCR). */
  | "OAUTH_SOFTWARE_STATEMENT_REQUIRED";

/** Anything the OAuth Authorization Server's registration surface can refuse to do. */
export class OAuthServerError extends LestoError<OAuthServerErrorCode> {
  constructor(code: OAuthServerErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "OAuthServerError";
  }
}

/**
 * The single throw every skeleton stub makes. Centralized so there is exactly one place
 * that says "not built yet," and so a grep for `OAUTH_NOT_IMPLEMENTED` finds every gap
 * the ADR 0029 Phase 3 build must fill.
 */
export function notImplemented(what: string): never {
  throw new OAuthServerError(
    "OAUTH_NOT_IMPLEMENTED",
    `${what} is a non-functional skeleton (ADR 0040) — not built yet`,
    { what },
  );
}
