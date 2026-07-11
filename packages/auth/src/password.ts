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
import {
  describeCostScrypt,
  hashPasswordScrypt,
  needsRehashScrypt,
  verifyPasswordScrypt,
} from "./password-scrypt";
import {
  describeCostWeb,
  hashPasswordWeb,
  needsRehashWeb,
  PBKDF2_PREFIX,
  verifyPasswordWeb,
} from "./password-web";
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

/**
 * A secret-free description of the KDF a stored hash was minted under — the
 * algorithm tag and its cost parameters, and NOTHING that could reconstruct the
 * hash (never the salt, never the derived key). Consumers put it on audit events
 * (e.g. `@lesto/identity`'s `password_rehashed`) so a monitor can tell a cost
 * UP-grade from a strength-reducing DOWN-grade.
 */
export type PasswordHashCost =
  | { readonly algorithm: "scrypt"; readonly n: number; readonly r: number; readonly p: number }
  | { readonly algorithm: "pbkdf2"; readonly iterations: number }
  | { readonly algorithm: "unknown" };

/**
 * Describe the KDF cost a stored hash was minted under — algorithm tag + cost
 * parameters ONLY, never the salt or derived key, so the result is safe to put on
 * an event a sink logs freely. Total and non-throwing: dispatches on the stored
 * prefix exactly as {@link verifyPassword} / {@link needsRehash} do, delegates to
 * each backend's own cost reader (which reuses that backend's `parseStored`, so this
 * can NEVER drift from what actually verifies), and collapses anything it does not
 * recognize — a corrupt row, or a format from a newer writer — to
 * `{ algorithm: "unknown" }`. When a new backend lands (e.g. argon2id, ADR 0046),
 * its arm is added HERE, in one place, rather than re-spelled by every consumer.
 *
 * ⚠️ This reads only the wire formats `@lesto/auth`'s OWN backends mint. A row minted
 * by a *custom* `PasswordHasher` (the `@lesto/identity` injection seam) in a foreign
 * or looser format — e.g. a stronger scrypt at `N > DEFAULT_N`, or a non-16/64-byte
 * shape — describes as `{ algorithm: "unknown" }` even though that hasher verifies it,
 * because describe is deliberately pinned to the same `parseStored` the built-in
 * verifier uses (never wider). Its audit-cost legibility is the custom hasher's own to
 * provide.
 */
export function describeHashCost(stored: string): PasswordHashCost {
  if (isPbkdf2(stored)) return describeCostWeb(stored) ?? { algorithm: "unknown" };

  // scrypt (current or legacy); a future argon2id arm slots in above this line.
  return describeCostScrypt(stored) ?? { algorithm: "unknown" };
}
