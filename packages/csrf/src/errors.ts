/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Volo surfaces a stable, machine-readable `code`. Logs, tests,
 * API responses, and the MCP surface branch on the code — never on a message
 * string, which is free to change for humans without breaking machines.
 */

import { VoloError } from "@volo/errors";

export { VoloError };

export type CsrfErrorCode = "CSRF_WEAK_SECRET";

/** Anything the CSRF layer can refuse to do. */
export class CsrfError extends VoloError<CsrfErrorCode> {
  constructor(code: CsrfErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "CsrfError";
  }
}

/** The minimum acceptable HMAC secret length, in bytes (256 bits of key material). */
export const MIN_SECRET_BYTES = 32;

/**
 * Refuse a CSRF signing secret weaker than {@link MIN_SECRET_BYTES}.
 *
 * The double-submit token's integrity is the HMAC under this secret; a short or
 * empty secret (a placeholder, an env var that resolved to "") makes every token
 * forgeable. Refused where the secret enters — minting a token and building the
 * middleware — so a weak key fails loud rather than silently weakening CSRF. The
 * total `verifyToken` predicate does NOT call this: it must stay total (a
 * verification of a token under a weak secret is simply `false`, never a throw).
 */
export function assertStrongSecret(secret: string): void {
  const bytes = Buffer.byteLength(secret, "utf8");

  if (bytes < MIN_SECRET_BYTES) {
    throw new CsrfError(
      "CSRF_WEAK_SECRET",
      `CSRF secret is too weak: ${bytes} bytes, need at least ${MIN_SECRET_BYTES}.`,
      { bytes, minBytes: MIN_SECRET_BYTES },
    );
  }
}
