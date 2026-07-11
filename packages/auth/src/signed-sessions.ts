/**
 * Stateless, signed sessions — a session you can trust with no store to consult.
 *
 * The store-backed {@link Sessions} keeps a row per session and looks it up to
 * verify. That cannot work where there is no shared store to look in — a
 * Cloudflare Worker isolate is ephemeral and per-PoP, so an in-memory store is
 * empty on the next request and a database round-trip defeats the point of the
 * edge.
 *
 * A signed session carries its own proof instead. The token is the claim
 * (`userId`, `expiresAt`) plus an HMAC-SHA256 signature of that claim under a
 * server-held secret:
 *
 *   token = base64url(claimJson) + "." + HMAC-SHA256(base64url(claimJson), secret)
 *
 * Verification recomputes the signature and compares it in constant time, then
 * checks the expiry against an injected clock. No state, no lookup — the
 * signature *is* the proof, so any isolate holding the secret can verify a
 * session it never issued. The cost is that a signed session cannot be revoked
 * before it expires (there is nothing to delete); keep the TTL short and pair
 * with the store-backed `Sessions` when instant revocation matters.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { assertStrongSecret } from "./errors";
import type { Clock } from "./types";
import { systemClock } from "./time";

/** The claim a signed session carries — who, and until when. */
export interface SignedClaim {
  readonly userId: string;

  /** Epoch milliseconds after which the token is no longer valid. */
  readonly expiresAt: number;
}

/** What {@link SignedSessions} needs: a signing secret and a clock to age tokens. */
export interface SignedSessionsOptions {
  /** The HMAC secret. The signature is only as strong as this value. */
  readonly secret: string;

  /** Current epoch milliseconds. Injected so tests drive expiry exactly. */
  readonly clock?: Clock;
}

// Joins the claim and its signature. base64url's alphabet excludes ".", so the
// split back into (claim, signature) is unambiguous.
const SEPARATOR = ".";

/** Sign the encoded claim with the secret. Lowercase hex. */
function sign(encodedClaim: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedClaim).digest("hex");
}

/** True iff two hex signatures are equal, in time independent of where they differ. */
function signaturesMatch(presented: string, expected: string): boolean {
  // `timingSafeEqual` throws on unequal BYTE lengths, so guard on the encoded
  // buffers — NOT `string.length`. A presented signature with the same UTF-16
  // string length but a multi-byte char (legal latin-1 in a header/cookie) has a
  // longer UTF-8 byte length; guarding on `string.length` would let it reach
  // `timingSafeEqual`, which then throws RangeError — breaking `verify`'s "never
  // throws" contract and turning a tampered token into a 500. An honest length
  // mismatch is already a non-match, so no constant-time concern there.
  const presentedBytes = Buffer.from(presented);
  const expectedBytes = Buffer.from(expected);

  if (presentedBytes.length !== expectedBytes.length) {
    return false;
  }

  return timingSafeEqual(presentedBytes, expectedBytes);
}

/** Decode the claim half of a token, or `undefined` if it is not a well-formed claim. */
function decodeClaim(encodedClaim: string): SignedClaim | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(encodedClaim, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const { userId, expiresAt } = parsed as Record<string, unknown>;

  if (typeof userId !== "string" || typeof expiresAt !== "number") {
    return undefined;
  }

  return { userId, expiresAt };
}

/**
 * Issues and verifies stateless signed session tokens.
 *
 * Built once with a secret (and, in tests, a clock); `issue` mints a token for a
 * user, `verify` returns the live claim or `undefined`. `verify` is total — it
 * never throws, so a tampered, expired, or garbage token is simply `undefined`,
 * never an exception an attacker can probe.
 */
export class SignedSessions {
  private readonly secret: string;

  private readonly clock: Clock;

  constructor(options: SignedSessionsOptions) {
    // A signed session is only as trustworthy as its HMAC key; refuse a weak
    // secret at construction rather than mint forgeable tokens (AUTH_WEAK_SECRET).
    assertStrongSecret(options.secret);

    this.secret = options.secret;
    this.clock = options.clock ?? systemClock;
  }

  /** Mint a token for `userId`, valid for `ttlMs` from now. */
  issue(userId: string, ttlMs: number): string {
    const claim: SignedClaim = { userId, expiresAt: this.clock() + ttlMs };

    const encodedClaim = Buffer.from(JSON.stringify(claim)).toString("base64url");

    return encodedClaim + SEPARATOR + sign(encodedClaim, this.secret);
  }

  /**
   * Resolve a token to its claim, or `undefined` when it cannot be trusted.
   *
   * Rejects, in order: a malformed shape (not exactly two parts), a signature
   * that does not match (tampered or forged), an unparseable claim, and an
   * expired one. Only a token this server signed and that is still in date
   * yields a claim.
   */
  verify(token: string): SignedClaim | undefined {
    const parts = token.split(SEPARATOR);

    if (parts.length !== 2) {
      return undefined;
    }

    const [encodedClaim, signature] = parts as [string, string];

    if (!signaturesMatch(signature, sign(encodedClaim, this.secret))) {
      return undefined;
    }

    const claim = decodeClaim(encodedClaim);

    if (claim === undefined || this.clock() >= claim.expiresAt) {
      return undefined;
    }

    return claim;
  }
}
