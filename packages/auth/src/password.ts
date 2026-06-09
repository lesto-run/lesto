import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing on scrypt.
 *
 * A stored hash is a single self-describing string:
 *
 *   scrypt$<saltHex>$<hashHex>
 *
 * The salt travels with the hash so verification needs nothing but the stored
 * value and the candidate password. Comparison is constant-time so a timing
 * side channel can't leak how many leading bytes matched.
 */

/** The algorithm tag every stored hash leads with. */
const PREFIX = "scrypt";

/** 16 random bytes is the conventional salt width — unique per password. */
const SALT_BYTES = 16;

/** scrypt's derived-key length, in bytes. */
const KEY_BYTES = 64;

/** Hash a password with a fresh random salt. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);

  const hash = scryptSync(password, salt, KEY_BYTES);

  return `${PREFIX}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * Verify a candidate password against a stored hash.
 *
 * Returns false — never throws — for a malformed stored string, whether the
 * algorithm prefix is wrong or the `$`-delimited shape is wrong. A caller
 * comparing user input should not have to wrap this in a try/catch.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [prefix, saltHex, hashHex, ...rest] = stored.split("$");

  // Wrong number of segments: not a hash we produced. A well-formed hash has
  // exactly three parts, so a defined fourth segment (or a missing salt/hash)
  // means the shape is wrong.
  if (saltHex === undefined || hashHex === undefined || rest.length > 0) return false;

  // Wrong algorithm tag: not a hash we produced.
  if (prefix !== PREFIX) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");

  // Fail closed on malformed stored material. We must NOT derive the candidate
  // key to `expected.length`: an empty or truncated stored hash would then make
  // scrypt produce a same-length (e.g. zero-length) buffer and timingSafeEqual
  // would report equality for EVERY password — auth failing open. The salt and
  // key widths are fixed by hashPassword, so anything else cannot be ours.
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;

  const actual = scryptSync(password, salt, KEY_BYTES);

  return timingSafeEqual(actual, expected);
}
