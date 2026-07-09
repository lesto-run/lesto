/**
 * Password hashing — the runtime-adaptive facade over the two KDF backends.
 *
 * `@lesto/auth` ships two hashers with an identical, self-describing string format
 * discipline:
 *
 *   - {@link ./password-scrypt} — memory-hard scrypt on `node:crypto`, for Node/Bun.
 *   - {@link ./password-web} — CPU-hard PBKDF2 on `crypto.subtle`, for the edge.
 *
 * scrypt at the default cost needs ~128 MiB of working memory, which OOM-crashes the
 * 128 MB Cloudflare Workers isolate on the first hash (L-7735be80). So this facade
 * **mints** under the algorithm {@link selectPasswordAlgorithm} picks for the host —
 * scrypt on Node, PBKDF2 on Workers — while **verification** dispatches on the
 * stored hash's own prefix, so a hash always verifies under the algorithm that made
 * it (PBKDF2 verifies on Node too). This is the drop-in default: `@lesto/identity`'s
 * `productionHasher` wraps these three functions, so a *greenfield* edge app — the
 * edge being the only writer — mints and reads only PBKDF2 and is edge-safe with no
 * wiring.
 *
 * ⚠️ CROSS-RUNTIME CAVEAT. scrypt cannot run on the edge (it OOMs). So a `scrypt$…`
 * hash that reaches an edge verifier — a DB *migrated* from Node, or a *hybrid* app
 * whose Node side minted the hash with the default `hashPassword` — cannot be
 * verified there and does not self-heal (`needsRehash` is false at the current cost,
 * so rehash-on-login never converts it). A hybrid/migrating deployment must mint
 * every hash the edge will read with {@link hashPasswordWeb} (pin PBKDF2 everywhere),
 * or re-hash the corpus to PBKDF2 before cutover. Tracked for a first-class path.
 *
 * `hashPassword` / `verifyPassword` / `needsRehash` keep the exact names and shapes
 * they had when scrypt was the only backend, so this change is transparent to every
 * existing caller. Callers that must pin an algorithm (e.g. minting PBKDF2 from Node
 * for a DB an edge app will read) can import the explicit `*Scrypt` / `*Web` variants.
 */

import { hashPasswordScrypt, needsRehashScrypt, verifyPasswordScrypt } from "./password-scrypt";
import { hashPasswordWeb, needsRehashWeb, PBKDF2_PREFIX, verifyPasswordWeb } from "./password-web";
import { selectPasswordAlgorithm } from "./runtime";

/** True iff `stored` is a PBKDF2 hash (so verify/needsRehash route to the web backend). */
function isPbkdf2(stored: string): boolean {
  return stored.startsWith(`${PBKDF2_PREFIX}$`);
}

/**
 * Hash a password under the KDF this runtime should mint with — PBKDF2 on the edge,
 * scrypt on Node. The result is self-describing, so verification needs only the
 * candidate and the stored value.
 */
export async function hashPassword(password: string): Promise<string> {
  return selectPasswordAlgorithm() === "pbkdf2"
    ? await hashPasswordWeb(password)
    : await hashPasswordScrypt(password);
}

/**
 * Verify a candidate against a stored hash, dispatching on the hash's own prefix so
 * it is checked under whatever algorithm minted it. Resolves `false` (never rejects)
 * for a malformed stored string; comparison is constant-time.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  return isPbkdf2(stored)
    ? await verifyPasswordWeb(password, stored)
    : await verifyPasswordScrypt(password, stored);
}

/**
 * Report whether a stored hash was minted below today's cost for its own algorithm —
 * the rehash-on-login seam. Dispatches on the stored prefix; a malformed string
 * reports `false`.
 */
export function needsRehash(stored: string): boolean {
  return isPbkdf2(stored) ? needsRehashWeb(stored) : needsRehashScrypt(stored);
}
