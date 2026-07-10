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
 * verified there. `verifyPassword` **refuses such a hash before touching the KDF**,
 * throwing a coded {@link AuthError} `AUTH_KDF_UNAVAILABLE` rather than attempting a
 * derive that would OOM-kill the whole isolate (an OOM is not a catchable error, so
 * the refusal must happen at dispatch, not inside the backend). `@lesto/identity`
 * catches that code and drives the migration story (a reset re-mints PBKDF2); see its
 * `onUnverifiableHash` option and the `docs/guide/edge-password-migration.md` runbook.
 * A hybrid/migrating deployment can also mint every hash the edge will read with
 * {@link hashPasswordWeb} (pin PBKDF2 everywhere) or convert on login before cutover.
 *
 * `hashPassword` / `verifyPassword` / `needsRehash` keep the exact names and shapes
 * they had when scrypt was the only backend, so this change is transparent to every
 * existing caller. Callers that must pin an algorithm (e.g. minting PBKDF2 from Node
 * for a DB an edge app will read) can import the explicit `*Scrypt` / `*Web` variants.
 */

import { AuthError } from "./errors";
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
 * it is checked under whatever algorithm minted it. A PBKDF2 hash verifies on every
 * runtime, resolving `false` for a malformed or mismatched value.
 *
 * On a runtime that cannot run scrypt (the edge), a **non-PBKDF2** stored string is
 * *rejected* rather than resolved: it routes to the scrypt backend, and deriving a
 * real scrypt hash there would need ~128 MiB and OOM-kill the isolate — which no
 * `try/catch` can rescue — so we refuse at dispatch with a coded {@link AuthError}
 * `AUTH_KDF_UNAVAILABLE`, never calling the KDF. (In practice a stored value is always
 * `scrypt$…` or `pbkdf2$…`; a corrupt non-PBKDF2 row is refused the same way rather
 * than risk a derive.) A **PBKDF2** hash whose iteration count exceeds what the edge
 * WebCrypto can derive (a legacy/hybrid `pbkdf2$…` row minted above `EDGE_MAX_ITERATIONS`)
 * is refused with the *same* coded `AUTH_KDF_UNAVAILABLE` for the same reason, so both
 * un-derivable shapes flow through one migration path. On a scrypt-capable host
 * (Node/Bun) scrypt hashes verify normally and malformed values resolve `false` as before.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (isPbkdf2(stored)) return await verifyPasswordWeb(password, stored);

  // A scrypt (or legacy `scrypt$salt$hash`) hash: run the memory-hard KDF only on a
  // host we positively identify as scrypt-capable. On the edge — or any runtime the
  // fail-safe probe does not call "scrypt" — refuse before the derive.
  if (selectPasswordAlgorithm() !== "scrypt") {
    throw new AuthError(
      "AUTH_KDF_UNAVAILABLE",
      "This password hash was minted with scrypt, which cannot run on this runtime (it would exhaust the isolate's memory). Re-hash it with PBKDF2 — e.g. via a password reset.",
      { algorithm: "scrypt" },
    );
  }

  return await verifyPasswordScrypt(password, stored);
}

/**
 * Report whether a stored hash was minted below today's cost for its own algorithm —
 * the rehash-on-login seam. Dispatches on the stored prefix; a malformed string
 * reports `false`.
 */
export function needsRehash(stored: string): boolean {
  return isPbkdf2(stored) ? needsRehashWeb(stored) : needsRehashScrypt(stored);
}
