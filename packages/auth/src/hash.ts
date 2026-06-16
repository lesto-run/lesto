import { createHash } from "node:crypto";

/**
 * SHA-256 of a string, lowercase hex.
 *
 * Used to store a session token by its *digest* rather than its plaintext: the
 * server only ever needs to look a presented token up by equality, and SHA-256
 * is a deterministic one-way map, so `sha256(token)` is a perfectly good lookup
 * key that a database snapshot can no longer be replayed from. The token itself
 * carries 256 bits of `randomBytes` entropy (see {@link generateToken}), so a
 * single unsalted SHA-256 is sufficient — there is no low-entropy password to
 * brute-force here, which is why this is a plain hash and not the scrypt KDF
 * `hashPassword` uses. The same plaintext always maps to the same digest, so
 * `find(token)` and `delete(token)` can hash on the way in and match the stored
 * row without any per-token state.
 */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
