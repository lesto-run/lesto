/**
 * Stateless double-submit CSRF tokens.
 *
 * A token is a random nonce paired with an HMAC-SHA256 signature of that nonce
 * under a server-held secret:
 *
 *   token = nonce + "." + HMAC-SHA256(nonce, secret)
 *
 * Verification recomputes the signature and compares in constant time, so no
 * per-token state lives on the server — the signature *is* the proof. A request
 * that echoes a token it could only have received from us proves same-origin.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// The two halves of a token, joined by a single ".".
const SEPARATOR = ".";

const NONCE_BYTES = 16;

/** Sign a nonce with the secret, returning the signature as lowercase hex. */
const sign = (nonce: string, secret: string): string =>
  createHmac("sha256", secret).update(nonce).digest("hex");

/**
 * Mint a fresh CSRF token: a random nonce and its signature under `secret`.
 * Two calls never collide — the nonce is 16 bytes of cryptographic randomness.
 */
export const generateToken = (secret: string): string => {
  const nonce = randomBytes(NONCE_BYTES).toString("hex");

  return nonce + SEPARATOR + sign(nonce, secret);
};

/**
 * Total predicate: does `token` carry a valid signature under `secret`?
 *
 * Never throws — any malformed shape is simply `false`. We guard the signature
 * length before the timing-safe compare, since `timingSafeEqual` throws on
 * buffers of unequal length.
 */
export const verifyToken = (token: string, secret: string): boolean => {
  const parts = token.split(SEPARATOR);

  // Invariant: a token is exactly two parts — nonce and signature.
  if (parts.length !== 2) return false;

  const [nonce, signature] = parts as [string, string];

  const expected = sign(nonce, secret);

  // Length guard before timingSafeEqual, which throws on a size mismatch.
  if (signature.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
};
