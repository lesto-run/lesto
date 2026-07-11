/**
 * Stateless double-submit CSRF tokens, bound to a session.
 *
 * A token is a random nonce paired with an HMAC-SHA256 signature of that nonce
 * AND the session id, under a server-held secret:
 *
 *   token = nonce + "." + HMAC-SHA256(nonce + "\0" + sessionId, secret)
 *
 * Verification recomputes the signature for the *presenting* session and
 * compares in constant time, so no per-token state lives on the server — the
 * signature *is* the proof. Binding to the session id closes a lateral gap: a
 * token minted for session A no longer verifies under session B, so a token
 * captured from one user cannot be replayed against another's session.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { assertStrongSecret } from "./errors";

// The two halves of a token, joined by a single ".".
const SEPARATOR = ".";

// Separates nonce from session id inside the signed payload. A byte that can
// never appear in the hex nonce, so (nonce, sessionId) maps to one payload
// unambiguously — no splicing of a long nonce into a short session id.
const BINDING_DELIMITER = "\0";

const NONCE_BYTES = 16;

/**
 * Sign a nonce, bound to a session, with the secret. Lowercase hex.
 *
 * The session id is folded into the signed payload so the signature is only
 * valid for the session it was minted for.
 */
const sign = (nonce: string, sessionId: string, secret: string): string =>
  createHmac("sha256", secret)
    .update(nonce + BINDING_DELIMITER + sessionId)
    .digest("hex");

/**
 * Mint a fresh CSRF token bound to `sessionId`: a random nonce and its
 * signature over (nonce, sessionId) under `secret`. Two calls never collide —
 * the nonce is 16 bytes of cryptographic randomness.
 */
export const generateToken = (sessionId: string, secret: string): string => {
  // A token minted under a weak secret is forgeable; refuse it loud (CSRF_WEAK_SECRET).
  assertStrongSecret(secret);

  const nonce = randomBytes(NONCE_BYTES).toString("hex");

  return nonce + SEPARATOR + sign(nonce, sessionId, secret);
};

/**
 * Total predicate: does `token` carry a valid signature for `sessionId` under
 * `secret`?
 *
 * Never throws — any malformed shape is simply `false`. We guard the signature
 * length before the timing-safe compare, since `timingSafeEqual` throws on
 * buffers of unequal length.
 */
export const verifyToken = (token: string, sessionId: string, secret: string): boolean => {
  const parts = token.split(SEPARATOR);

  // Invariant: a token is exactly two parts — nonce and signature.
  if (parts.length !== 2) return false;

  const [nonce, signature] = parts as [string, string];

  const expected = sign(nonce, sessionId, secret);

  const signatureBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);

  // Guard on *byte* length, not string length. An HTTP header is latin-1, so a
  // forged signature of the same string length can still carry non-ASCII chars
  // that encode to more UTF-8 bytes — and timingSafeEqual throws RangeError on a
  // byte-size mismatch. A string-length guard would let that throw escape and
  // turn an attacker's 403 into a 500; the byte guard keeps verify total.
  if (signatureBytes.length !== expectedBytes.length) return false;

  return timingSafeEqual(signatureBytes, expectedBytes);
};
