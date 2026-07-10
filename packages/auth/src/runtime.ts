/**
 * Which password KDF this runtime should mint with (L-7735be80).
 *
 * scrypt is memory-hard: at the default cost (N=2^17) its working set is ~128 MiB,
 * which is at/over the 128 MB Cloudflare Workers isolate cap — so the very first
 * password hash OOM-crashes an edge app. On the edge we instead mint with PBKDF2
 * over `crypto.subtle` — CPU-hard, negligible memory, and a WebCrypto primitive
 * present on workerd, Deno, Bun, and Node alike. See {@link hashPasswordScrypt} and
 * {@link hashPasswordWeb}; the adaptive facade in `./password` calls this to choose.
 *
 * The choice is **fail-safe**: scrypt is selected ONLY when we can positively
 * identify a Node-like host that is NOT workerd. Every ambiguous or unknown runtime
 * falls to PBKDF2, because the two mistakes are not symmetric — a misdetected Node
 * running PBKDF2 is still fully secure, while a misdetected edge running scrypt
 * crashes the isolate. When in doubt, we pick the one that cannot crash.
 */

/** The password KDFs `@lesto/auth` can mint with. */
export type PasswordAlgorithm = "scrypt" | "pbkdf2";

/**
 * True iff this runtime is a Cloudflare Workers (workerd) isolate.
 *
 * Detected by two independent signals: the documented `navigator.userAgent`, and
 * the `WebSocketPair` constructor. We check both because `navigator` is gated
 * behind the `global_navigator` compat flag (only default on recent compat dates),
 * whereas `WebSocketPair` is an ungated core Workers global that no Node/Bun/Deno
 * runtime defines — so an older-compat-date Worker running `nodejs_compat` (which
 * polyfills `process` and would otherwise look like Node in {@link selectPasswordAlgorithm},
 * then OOM on scrypt) is still caught here.
 *
 * This is the single probe both the algorithm choice AND the PBKDF2 iteration
 * ceiling read from — the edge is the runtime whose WebCrypto hard-caps PBKDF2
 * iterations (see `./password-web` `EDGE_MAX_ITERATIONS`).
 */
export function isWorkerd(): boolean {
  // Read the globals through a cast rather than the ambient `navigator` binding:
  // this module compiles under `lib: ES2023` with only `@types/node`, and an edge
  // runtime need not have either global at all — the optional chains are genuine.
  const globals = globalThis as {
    navigator?: { userAgent?: string };
    WebSocketPair?: unknown;
  };

  return (
    globals.navigator?.userAgent === "Cloudflare-Workers" || globals.WebSocketPair !== undefined
  );
}

/**
 * Pick the KDF to mint new hashes under, based on the host runtime.
 *
 * Verification never calls this — a stored hash is self-describing and is verified
 * under whatever algorithm its prefix names (`./password` dispatches on it), so a
 * hash minted on one runtime still verifies wherever the algorithm is available.
 * Only *minting* is runtime-selected.
 */
export function selectPasswordAlgorithm(): PasswordAlgorithm {
  // workerd first: it must never run memory-hard scrypt (the derive OOM-kills the
  // 128 MB isolate), so an ambiguous-but-workerd runtime is routed to PBKDF2 here.
  if (isWorkerd()) return "pbkdf2";

  // A genuine Node/Bun host exposes `process.versions.node`; scrypt is safe there.
  // Anything else — an unknown edge, a stripped runtime — falls to PBKDF2.
  const globals = globalThis as { process?: { versions?: { node?: string } } };

  return globals.process?.versions?.node !== undefined ? "scrypt" : "pbkdf2";
}
