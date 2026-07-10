/**
 * Password hashing on PBKDF2 — the edge/WebCrypto implementation, versioned,
 * self-describing, and async.
 *
 * This is the CPU-hard KDF the adaptive facade in `./password` selects on
 * Cloudflare Workers (and any non-Node runtime). It exists because scrypt's
 * ~128 MiB working set OOM-crashes the 128 MB Workers isolate on the first hash
 * (see {@link ./password-scrypt} and {@link ./runtime}); PBKDF2 over `crypto.subtle`
 * uses negligible memory and is a WebCrypto primitive present on workerd, Deno,
 * Bun, and Node alike, so it runs unchanged on the edge.
 *
 * A stored hash carries its own parameters, mirroring the scrypt format:
 *
 *   pbkdf2$<digest>$<iterations>$<saltHex>$<keyHex>
 *
 * The digest tag and iteration count travel with the hash, so a hash minted under
 * an older (cheaper) cost still verifies, and {@link needsRehashWeb} reports when a
 * stored hash is below today's cost so the caller can transparently re-hash it on
 * the next successful login.
 *
 * Honest note on CPU: a secure KDF is *deliberately* expensive, so password
 * hashing does not fit the Workers **free** plan's 10 ms CPU cap on any KDF,
 * PBKDF2 included — a real edge deployment doing password auth needs the paid
 * plan's higher CPU limit. What this module buys unconditionally is that the edge
 * no longer *crashes*: it exchanges scrypt's fatal OOM for PBKDF2's bounded CPU.
 *
 * Fail closed, exactly like the scrypt path: any malformed stored string verifies
 * to `false` rather than throwing, and comparison is constant-time.
 */

import { AuthError } from "./errors";
import { isWorkerd } from "./runtime";

/** The algorithm tag every PBKDF2 stored hash leads with. */
export const PBKDF2_PREFIX = "pbkdf2";

/** 16 random bytes — the same salt width the scrypt path uses. */
const SALT_BYTES = 16;

/** Derived-key length in bytes (256 bits — the natural SHA-256 output width). */
const KEY_BYTES = 32;

/**
 * The one digest we mint under today, as a compact tag mapped to its WebCrypto
 * name. Kept as a table (rather than a bare constant) so the stored format is
 * self-describing and a future SHA-512 upgrade is a one-line addition that old
 * hashes keep verifying against.
 */
const DIGESTS: Record<string, string> = { sha256: "SHA-256" };

/** The tag {@link hashPasswordWeb} stamps into every hash it mints. */
const DEFAULT_DIGEST_TAG = "sha256";

/**
 * The hard ceiling on PBKDF2 iterations, imposed by the runtime this format exists
 * to serve.
 *
 * Cloudflare Workers' WebCrypto rejects any `deriveBits` above 100,000 iterations
 * with `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 * supported` — a fixed workerd DoS guard, NOT raisable via a compat flag or
 * `compatibility_date` (cloudflare/workerd#1346). It gates BOTH minting and
 * verifying (both go through `deriveBits`), so a hash minted above it is unusable
 * on the edge in either direction.
 *
 * A `pbkdf2$…` hash exists precisely because scrypt OOM-crashes the edge (see the
 * module header and `./runtime`): its whole reason to be is to run on Workers. So
 * this ceiling is the format's defining invariant — every hash we mint stays at or
 * under it, on EVERY runtime, and is therefore edge-runnable by construction.
 *
 * ⚠️ 100k SHA-256 is ~6× below OWASP-2023's 600k recommendation — an honest strength
 * regression for edge users against the *offline* crack of an exfiltrated hash DB (a
 * rate limiter bounds only online guessing). It is the strongest PBKDF2 the edge
 * WebCrypto will run, but the platform forces only "not scrypt", NOT "PBKDF2": a
 * memory-hard argon2id via WASM fits the 128 MB isolate and would restore the margin.
 * So this is an interim floor, not a hard ceiling on edge password security — the
 * tracked follow-up is an ADR to move the edge KDF to argon2id-wasm. (Node/Bun
 * deployments get memory-hard scrypt via the facade in `./password`; this floor
 * applies only to the edge-portable format.)
 */
export const EDGE_MAX_ITERATIONS = 100_000;

/**
 * Iteration count for a freshly minted hash. Pinned to {@link EDGE_MAX_ITERATIONS}
 * so a minted hash runs on the edge unconditionally. Read back per-hash on verify,
 * so a hash minted under a different cost still verifies and {@link needsRehashWeb}
 * flags it for a rehash toward this target.
 */
const DEFAULT_ITERATIONS = EDGE_MAX_ITERATIONS;

const ENCODER = new TextEncoder();

/** The parsed parameters, salt, and expected key of a stored PBKDF2 hash. */
interface Pbkdf2Parsed {
  readonly digest: string;
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly expected: Uint8Array;
}

/** True iff `value` is a finite integer strictly greater than zero. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** Lowercase hex of `bytes`. */
function toHex(bytes: Uint8Array): string {
  let hex = "";

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

/**
 * Decode an even-length hex string to bytes, or `undefined` for anything that is
 * not clean hex. The regex + even-length guard mean the `parseInt` below can never
 * see a non-hex pair, so it never yields `NaN`.
 */
function fromHex(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return undefined;

  const out = new Uint8Array(hex.length / 2);

  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return out;
}

/**
 * Parse a stored hash into its parameters, salt, and expected key.
 *
 * Returns `undefined` — never throws — for anything that is not a hash this module
 * could have produced: wrong prefix, wrong arity, an unknown digest tag,
 * non-numeric/non-positive iterations, non-hex or mis-sized salt/key. Centralizing
 * every invariant here keeps {@link verifyPasswordWeb} a thin constant-time compare.
 */
function parseStored(stored: string): Pbkdf2Parsed | undefined {
  const parts = stored.split("$");

  // Format: pbkdf2$digest$iterations$salt$key — exactly five segments.
  if (parts.length !== 5) return undefined;

  const [prefix, digestTag, iterRaw, saltHex, keyHex] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (prefix !== PBKDF2_PREFIX) return undefined;

  // Unknown digest tag: not one we mint, so not a string we could have produced.
  // `Object.hasOwn`, not `DIGESTS[tag] === undefined` — a bare index resolves
  // inherited `Object.prototype` members (`toString`, `constructor`, …) to real
  // values, which would slip past the guard and hand `crypto.subtle` a function
  // as the hash name, making it THROW rather than fail closed to `false`.
  if (!Object.hasOwn(DIGESTS, digestTag)) return undefined;
  const digest = DIGESTS[digestTag]!;

  const iterations = Number(iterRaw);
  if (!isPositiveInteger(iterations)) return undefined;

  const salt = fromHex(saltHex);
  const expected = fromHex(keyHex);
  if (salt === undefined || expected === undefined) return undefined;

  // Fail closed on mis-sized material. The salt and key widths are fixed, so a
  // truncated or empty stored hash cannot be ours — reject rather than derive a
  // candidate key that a length-matched compare could pass for every password.
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return undefined;

  return { digest, iterations, salt, expected };
}

/** Derive `KEY_BYTES` of key material via PBKDF2, off the main work path. */
async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
  digest: string,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    // ArrayBuffer-backed cast: satisfies `BufferSource` under the stricter
    // Workers/DOM libs a consumer may compile against (mirrors channel-token.ts).
    ENCODER.encode(password) as Uint8Array<ArrayBuffer>,
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: digest, salt: salt as Uint8Array<ArrayBuffer>, iterations },
    keyMaterial,
    KEY_BYTES * 8,
  );

  return new Uint8Array(bits);
}

/**
 * Constant-time byte-equality.
 *
 * The caller guarantees equal length — `actual` is always {@link KEY_BYTES} (derived
 * to a fixed width) and `expected` is validated to {@link KEY_BYTES} in
 * {@link parseStored} — so this mirrors `node:crypto`'s `timingSafeEqual`, which
 * itself requires equal-length inputs and which the scrypt path relies on the same
 * way. It compares every byte regardless of where a difference appears.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = 0;

  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }

  return diff === 0;
}

/**
 * Hash a password with a fresh random salt under the current PBKDF2 cost.
 *
 * The returned string is self-describing — it carries the digest tag, the iteration
 * count, and the salt it was minted under — so {@link verifyPasswordWeb} needs only
 * the candidate and the stored value. Salt generation runs inside the call (request
 * scope), never at module load, because a Worker forbids randomness in global scope.
 *
 * The cost is pinned to {@link EDGE_MAX_ITERATIONS} and is deliberately NOT
 * configurable. Upward is impossible — the edge cannot derive above the ceiling, and
 * an over-ceiling `pbkdf2$…` hash violates the format's whole reason to exist.
 * Downward is a footgun with no honest use: it is strictly weaker against an offline
 * crack, and {@link needsRehashWeb}'s `!==` check silently walks any cheaper hash
 * back up to the pinned target on the next login, so the "savings" self-revert on
 * the very path a CPU-constrained caller was trying to protect. Tests that need a
 * hash at a different cost mint one directly against the wire format (see the
 * `pbkdf2Hash` fixture in `test/password-web.test.ts`), which `verifyPasswordWeb`
 * round-trips cross-check against this real path.
 */
export async function hashPasswordWeb(password: string): Promise<string> {
  const iterations = DEFAULT_ITERATIONS;

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  const key = await deriveKey(password, salt, iterations, DIGESTS[DEFAULT_DIGEST_TAG]!);

  return `${PBKDF2_PREFIX}$${DEFAULT_DIGEST_TAG}$${iterations}$${toHex(salt)}$${toHex(key)}`;
}

/**
 * Verify a candidate password against a stored PBKDF2 hash.
 *
 * Resolves `false` — never rejects — for a malformed stored string. The candidate
 * key is derived under the digest and iteration count read back from `stored`, so a
 * hash minted under an older cost still verifies. Comparison is constant-time.
 *
 * The one case this rejects rather than resolves: a well-formed hash whose iteration
 * count exceeds {@link EDGE_MAX_ITERATIONS} *on workerd*. The derive would throw an
 * uncatchable-contract-breaking `NotSupportedError` from inside `crypto.subtle`, so
 * we refuse it first with a coded {@link AuthError} `AUTH_KDF_UNAVAILABLE` — exactly
 * as the facade does for scrypt-on-edge — routing it through the same migration story
 * (`@lesto/identity` `onUnverifiableHash`; the rehash seam walks it down on the next
 * login on a runtime that CAN derive it). Off workerd (Node/Bun/Deno) there is no cap,
 * so such a hash verifies normally — the guard is deliberately runtime-conditional.
 */
export async function verifyPasswordWeb(password: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);

  if (parsed === undefined) return false;

  const { digest, iterations, salt, expected } = parsed;

  if (isWorkerd() && iterations > EDGE_MAX_ITERATIONS) {
    throw new AuthError(
      "AUTH_KDF_UNAVAILABLE",
      `This PBKDF2 hash uses ${iterations} iterations, above the ${EDGE_MAX_ITERATIONS} this edge runtime can derive; re-hash it (e.g. via a password reset).`,
      { algorithm: "pbkdf2", iterations, max: EDGE_MAX_ITERATIONS },
    );
  }

  const actual = await deriveKey(password, salt, iterations, digest);

  return timingSafeEqual(actual, expected);
}

/**
 * Report whether a stored PBKDF2 hash was minted at anything other than today's
 * iteration count — the rehash-on-login seam, matching {@link needsRehashScrypt}.
 *
 * Stale means `iterations !== DEFAULT_ITERATIONS`, not merely below it: a hash under
 * the target walks *up*, and a legacy over-ceiling hash (e.g. a `600000` row from a
 * pre-fix build) walks *down* to the edge-runnable {@link EDGE_MAX_ITERATIONS} on the
 * next login. Because the target equals the ceiling on every runtime, a freshly
 * minted hash is never stale, so the seam converges in a single hop instead of
 * re-minting on every login. A malformed string reports `false`: it is not a hash we
 * can re-derive.
 */
export function needsRehashWeb(stored: string): boolean {
  const parsed = parseStored(stored);

  if (parsed === undefined) return false;

  return parsed.iterations !== DEFAULT_ITERATIONS;
}
