import { randomBytes } from "node:crypto";

/** Default token width, in bytes — 256 bits of entropy. */
const DEFAULT_BYTES = 32;

/**
 * A cryptographically random opaque token, hex-encoded.
 *
 * Used for session ids and one-off secrets; the hex string is twice the byte
 * width in characters.
 */
export function generateToken(bytes?: number): string {
  return randomBytes(bytes ?? DEFAULT_BYTES).toString("hex");
}
