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
 * iterations (see `./password-web` `EDGE_MAX_ITERATIONS`). That second role cuts
 * BOTH ways: a false "workerd" on a real Node host is no longer merely suboptimal —
 * it mints weaker 100k PBKDF2 AND makes `verifyPassword` REFUSE every scrypt row
 * with `AUTH_KDF_UNAVAILABLE`, failing every existing login. So the probe is
 * deliberately hardened against the inverse of the `nodejs_compat` trap: a
 * Cloudflare polyfill/ponyfill/bundler shim leaking `WebSocketPair` into a NODE
 * host's global scope.
 *
 * The detection is deliberately FAIL-SAFE (see the doctrine above): only a
 * *recognized* brand is authoritative. A positive `Cloudflare-Workers` brand ⇒
 * workerd; a recognized non-edge brand (Node ≥ 21 `Node.js/NN`, Bun, Deno) ⇒ not
 * workerd, which vetoes a leaked `WebSocketPair` shim on a modern Node host. Any
 * UNKNOWN or absent brand — an older-compat-date Worker with no `navigator`, or a
 * real Worker onto which a library planted a non-edge `navigator` — falls through
 * to the ungated `WebSocketPair` probe, so a genuine workerd is NEVER mis-routed
 * to scrypt (which OOM-crashes the isolate). An earlier revision made *any* string
 * brand authoritative-negative and skipped the fallback; that reopened the exact
 * catastrophic direction this module exists to forbid.
 *
 * ⚠️ Residual invariant: on an UNBRANDED host (Node ≤ 20, no `navigator`) a leaked
 * `WebSocketPair` *constructor* is indistinguishable from workerd and flips this
 * probe to edge — minting weaker PBKDF2 + refusing scrypt rows (recoverable via a
 * reset, never a crash). A Node deployment must not leak a Cloudflare shim's
 * `WebSocketPair` into global scope; a workerd deployment must not overwrite
 * `navigator.userAgent` with a non-edge brand.
 */
export function isWorkerd(): boolean {
  // Read the globals through a cast rather than the ambient `navigator` binding:
  // this module compiles under `lib: ES2023` with only `@types/node`, and an edge
  // runtime need not have either global at all — the optional chains are genuine.
  const globals = globalThis as {
    navigator?: { userAgent?: string };
    WebSocketPair?: unknown;
  };

  const userAgent = globals.navigator?.userAgent;

  // A POSITIVE Cloudflare brand is authoritative ⇒ workerd. (Substring-matched
  // only to tolerate a hypothetical future version suffix.)
  if (userAgent?.includes("Cloudflare-Workers")) return true;

  // A RECOGNIZED non-edge brand (Node ≥ 21 `Node.js/NN`, Bun, Deno) is
  // authoritative the other way ⇒ NOT workerd, vetoing a leaked `WebSocketPair`
  // shim on a modern Node host (which would otherwise mint weaker PBKDF2 and make
  // verify REFUSE every scrypt row).
  if (userAgent !== undefined && /Node\.js|Bun|Deno/.test(userAgent)) return false;

  // Unknown or absent brand (older-compat-date workerd has no `navigator`; a lib
  // may also plant a non-edge `navigator` on a real Worker): fall through to the
  // ungated core Workers global. This preserves the FAIL-SAFE doctrine — a real
  // workerd is never mis-routed to scrypt — while requiring a real CONSTRUCTOR
  // (`typeof … === "function"`, not merely "defined") so a non-callable
  // placeholder can't flip a Node host into edge mode.
  return typeof globals.WebSocketPair === "function";
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
