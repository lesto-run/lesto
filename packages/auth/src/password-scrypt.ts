import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing on scrypt — the Node/Bun implementation, versioned,
 * self-describing, and async.
 *
 * This is the memory-hard KDF; the adaptive facade in `./password` selects it only
 * on a Node-like runtime, because its ~128 MiB working set OOM-crashes a Cloudflare
 * Workers isolate (see {@link ./runtime}, which routes the edge to PBKDF2 instead).
 *
 * A stored hash is a single string that carries its own cost parameters:
 *
 *   scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
 *
 * The salt AND the scrypt work factors (`N`, `r`, `p`) travel with the hash, so
 * verification needs nothing but the stored value and the candidate password.
 * Because the parameters are read back from the stored string, a hash minted
 * under an *older* (cheaper) cost still verifies for as long as it lives in the
 * database — we never assume the current defaults. {@link needsRehashScrypt} reports
 * when a stored hash is below today's cost so the caller can transparently
 * re-hash it on the next successful login.
 *
 * Two correctness properties this module is built around:
 *
 *   - **Async, bounded scrypt.** scrypt is CPU- *and* memory-hard; the
 *     synchronous `scryptSync` would block the event loop for the full derive,
 *     turning a flood of login attempts into a denial-of-service amplifier. We
 *     use the libuv-threadpool `scrypt` (promisified) and pass an explicit
 *     `maxmem` so the work factor can be raised past Node's default 32 MiB
 *     ceiling without the derive throwing.
 *   - **Fail closed.** Comparison is constant-time, and any malformed stored
 *     string (wrong tag, wrong arity, non-numeric params, mis-sized salt/key)
 *     verifies to `false` rather than throwing — a caller comparing user input
 *     never has to wrap this in a try/catch, and a truncated stored hash can
 *     never make verification pass for every password.
 *
 * @see needsRehashScrypt for the rehash-on-login seam.
 */

/**
 * Promisified scrypt that preserves the cost-parameter `options` overload.
 *
 * `util.promisify(scrypt)`'s inferred type collapses to the 3-arg
 * `(password, salt, keylen)` signature and drops the `options` overload we
 * depend on, so we promisify the value and re-assert the fuller call signature.
 * The derive runs on the libuv threadpool, off the event loop.
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/** The algorithm tag every stored hash leads with. */
const PREFIX = "scrypt";

/** 16 random bytes is the conventional salt width — unique per password. */
const SALT_BYTES = 16;

/** scrypt's derived-key length, in bytes. */
const KEY_BYTES = 64;

/**
 * Current scrypt cost parameters — what {@link hashPasswordScrypt} mints today.
 *
 *   - `N` is the CPU/memory cost (must be a power of two). 2^17 = 131072 lands
 *     around ~150–200 ms per derive on 2025-class server hardware and ~128 MiB
 *     of working memory (≈ `128 · N · r` bytes), comfortably above the OWASP
 *     scrypt floor. This is a deliberate bump from the legacy default of 2^14.
 *   - `r` (block size, 8) and `p` (parallelism, 1) are the standard pairing.
 */
const DEFAULT_N = 2 ** 17;
const DEFAULT_R = 8;
const DEFAULT_P = 1;

/**
 * The scrypt memory ceiling, in bytes.
 *
 * scrypt needs roughly `128 · N · r` bytes of working memory; at the default
 * cost that is ~128 MiB, which exceeds Node's built-in 32 MiB `maxmem` default
 * and would make the derive throw. We set the ceiling to 256 MiB — double the
 * default-cost footprint — so today's parameters derive with margin. A future
 * `N` bump raises this ceiling alongside `DEFAULT_N` (the next power of two,
 * N=2^18, already needs ~256 MiB), and `parseStored` rejects any `N > DEFAULT_N`
 * so a stored hash can never demand more memory than this constant allows.
 */
const MAXMEM = 256 * 1024 * 1024;

/** The parsed cost parameters carried by (or inferred for) a stored hash. */
interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/**
 * Parse a stored hash into its parameters, salt, and expected key.
 *
 * Returns `undefined` — never throws — for anything that is not a hash this
 * module could have produced, in either shape:
 *
 *   - **current**: `scrypt$N$r$p$saltHex$hashHex` (six segments)
 *   - **legacy**:  `scrypt$saltHex$hashHex` (three segments, no params) — the
 *     pre-versioned format, read back at the cost it was actually minted under
 *     (N=2^14, r=8, p=1). Old rows must still verify; they get upgraded by the
 *     {@link needsRehashScrypt} seam on the next login.
 *
 * Every numeric/size invariant is checked here so {@link verifyPasswordScrypt} can
 * be a thin constant-time comparison and {@link needsRehashScrypt} can reuse the
 * parse.
 */
function parseStored(
  stored: string,
): { params: ScryptParams; salt: Buffer; expected: Buffer } | undefined {
  const parts = stored.split("$");

  const [prefix] = parts;

  // Wrong algorithm tag: not a hash we produced.
  if (prefix !== PREFIX) return undefined;

  let params: ScryptParams;
  let saltHex: string;
  let hashHex: string;

  if (parts.length === 6) {
    // Current format: scrypt$N$r$p$salt$hash.
    const [, nRaw, rRaw, pRaw, salt, hash] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);

    // Reject non-numeric / non-positive / non-integer params. scrypt also
    // requires N to be a power of two greater than one — anything else is not a
    // string we minted, so fail closed rather than hand garbage to the derive.
    if (!isPositiveInteger(N) || !isPositiveInteger(r) || !isPositiveInteger(p)) return undefined;
    if (!isPowerOfTwo(N)) return undefined;

    // Reject a cost ABOVE what we mint today: we only ever raise `N`, never above
    // the current default, so a larger `N` is not a hash this module produced — and
    // deriving it would exceed `MAXMEM` and make `scryptAsync` THROW, breaking the
    // "verifies to false, never rejects" contract. Fail closed here instead.
    if (N > DEFAULT_N) return undefined;

    params = { N, r, p };
    saltHex = salt;
    hashHex = hash;
  } else if (parts.length === 3) {
    // Legacy format: scrypt$salt$hash — minted before the format carried its
    // parameters. Read it at the cost it was actually produced under.
    const [, salt, hash] = parts as [string, string, string];

    params = { N: 2 ** 14, r: 8, p: 1 };
    saltHex = salt;
    hashHex = hash;
  } else {
    // Wrong number of segments: not a hash we produced.
    return undefined;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");

  // Fail closed on mis-sized material. We must NOT derive the candidate key to
  // `expected.length`: an empty or truncated stored hash would then make scrypt
  // produce a same-length buffer and `timingSafeEqual` would report equality
  // for EVERY password — auth failing open. The salt and key widths are fixed,
  // so anything else cannot be ours.
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return undefined;

  return { params, salt, expected };
}

/** True iff `value` is a finite integer strictly greater than zero. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** True iff `value` is a power of two greater than one (scrypt's N constraint). */
function isPowerOfTwo(value: number): boolean {
  return value > 1 && (value & (value - 1)) === 0;
}

/**
 * Hash a password with a fresh random salt under the current scrypt cost.
 *
 * Async: the scrypt derive runs on the libuv threadpool so it never blocks the
 * event loop. The returned string is self-describing — it carries the salt and
 * the `N`/`r`/`p` it was minted under, so {@link verifyPasswordScrypt} needs only
 * the candidate and the stored value.
 */
export async function hashPasswordScrypt(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);

  const hash = await scryptAsync(password, salt, KEY_BYTES, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: MAXMEM,
  });

  return `${PREFIX}$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${salt.toString("hex")}$${hash.toString(
    "hex",
  )}`;
}

/**
 * Verify a candidate password against a stored scrypt hash.
 *
 * Resolves `false` — never rejects — for a malformed stored string, whatever
 * the cause (wrong prefix, wrong arity, non-numeric params, mis-sized
 * salt/key). The candidate key is derived under the parameters read back from
 * `stored`, so a hash minted under an older cost still verifies. Comparison is
 * constant-time.
 */
export async function verifyPasswordScrypt(password: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);

  if (parsed === undefined) return false;

  const { params, salt, expected } = parsed;

  const actual = await scryptAsync(password, salt, KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAXMEM,
  });

  return timingSafeEqual(actual, expected);
}

/**
 * Report whether a stored scrypt hash was minted under weaker parameters than
 * today's defaults — the rehash-on-login seam.
 *
 * A caller that has *just verified* a password (so it holds the plaintext) can
 * call this and, when it returns `true`, re-hash the plaintext with
 * {@link hashPasswordScrypt} and persist the upgraded value. That transparently
 * walks the whole user base up to the current cost as people log in, with no
 * forced reset. Legacy (parameterless) hashes — and any hash whose `N`/`r`/`p` are
 * below the current defaults — report `true`. A malformed string reports
 * `false`: it is not a hash we can re-derive, so the caller should leave it
 * alone (a failed verify will already have rejected the login).
 */
export function needsRehashScrypt(stored: string): boolean {
  const parsed = parseStored(stored);

  if (parsed === undefined) return false;

  const { N, r, p } = parsed.params;

  return N < DEFAULT_N || r < DEFAULT_R || p < DEFAULT_P;
}

/**
 * Describe the cost a stored scrypt hash was minted under — the algorithm tag and
 * work factors ONLY, projecting away the salt and derived key so the result is safe
 * to put on an audit event a sink logs freely (never the salt, never the key).
 *
 * Reuses {@link parseStored}, so it can never drift from what the verifier accepts
 * and it reads a legacy parameterless row back at its true cost (N=2^14). Returns
 * `undefined` for any string this backend did not mint, so the {@link ./password}
 * facade's `describeHashCost` can fall through to the next backend.
 */
export function describeCostScrypt(
  stored: string,
):
  | { readonly algorithm: "scrypt"; readonly n: number; readonly r: number; readonly p: number }
  | undefined {
  const parsed = parseStored(stored);

  if (parsed === undefined) return undefined;

  const { N, r, p } = parsed.params;

  return { algorithm: "scrypt", n: N, r, p };
}
