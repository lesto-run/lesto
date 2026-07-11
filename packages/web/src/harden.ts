/**
 * Transport-neutral response hardening — the security layer BOTH runtimes share.
 *
 * The node server (`@lesto/runtime`) and the Cloudflare edge (`@lesto/cloudflare`)
 * are two front doors to the *same* dispatcher, and a security posture that lives
 * in only one of them is a gap: the field's SSR CVEs again and again landed in an
 * adapter (a `Host` header trusted in the Express adapter, headers not stripped on
 * one path) rather than the shared core. So the pure pieces — default security
 * headers, the opt-in CSP/COEP knobs, and the error→status/body mapping — live
 * here in `@lesto/web`, which both transports already depend on, and neither
 * reimplements them. The node-specific bits (socket reads, timeouts, ETag hashing
 * over `node:crypto`, the access log) stay in the runtime; everything a Worker can
 * and must also do is here.
 *
 * Pure and dependency-light: a function of a response (or an error) and a config,
 * so every branch is unit-testable without a socket or a `fetch` runtime.
 */

import { isLestoError } from "@lesto/errors";

import type { AnyLestoResponse, HeaderMap } from "./types";

/**
 * A restrictive default `Permissions-Policy`: powerful features off until asked.
 *
 * The browser's secure-default principle applied to capabilities — a page that
 * never uses the camera, microphone, or geolocation should not be *able* to, even
 * if an injected script tries. `interest-cohort=()` opts out of FLoC/Topics. An
 * app that genuinely needs a feature sets its own policy, which wins the merge.
 */
const DEFAULT_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), interest-cohort=()";

/**
 * The headers put under every response by default.
 *
 * The unambiguously-safe set that needs no per-app tuning: no MIME sniffing, a
 * privacy-preserving referrer, framing denied, HSTS for any TLS terminator in
 * front, a cross-origin opener boundary, and a restrictive permissions policy. No
 * CSP (a safe one depends on the app's own inline scripts — island bootstrap
 * inlines JSON) and no COEP (`require-corp` breaks cross-origin subresources):
 * both are opt-in via {@link SecurityHeaderOptions}.
 */
export const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": DEFAULT_PERMISSIONS_POLICY,
};

/**
 * A recommended Content-Security-Policy for an app that does NOT inline scripts.
 *
 * Documentation-in-code: a sane starting policy once an app has eliminated inline
 * `<script>` blocks (or moved island bootstrap behind a nonce / a
 * `type="application/json"` payload). NOT a default precisely because Lesto's
 * island bootstrap currently inlines JSON, which `script-src 'self'` would block.
 */
export const RECOMMENDED_CSP =
  "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; upgrade-insecure-requests";

/** The header `require-corp` rides on when COEP is opted in. */
const COEP_HEADER = "Cross-Origin-Embedder-Policy";

/**
 * Merge an OVER header map onto an UNDER one — the over layer wins, matched by
 * name case-insensitively, with `Set-Cookie` accumulated rather than clobbered.
 *
 * The hazard a naive `{ ...under, ...over }` spread hides: object keys are
 * case-*sensitive*, so an under-layer `set-cookie` and an over-layer `Set-Cookie`
 * survive as TWO entries — and a node `writeHead`/`Headers` then emits both,
 * silently doubling a cookie or leaking the under value the over meant to
 * replace. HTTP header names are case-insensitive, so we resolve collisions by
 * lowercased name: the over value replaces the under value under the SAME key,
 * whatever its casing.
 *
 * `Set-Cookie` is the one header we ACCUMULATE instead of replace: two layers
 * each setting a cookie (a session middleware under a CSRF middleware) both
 * belong on the wire — losing either drops a cookie. So when both layers carry
 * `set-cookie`, their values concatenate into one list (under first, over
 * second), which each transport then emits as one line per element.
 *
 * `Vary` is the one header we UNION instead of replace. It names the request
 * headers a response was computed from, and both layers may legitimately
 * contribute a reason: a CORS policy adds `Vary: Origin` (so a shared cache keys
 * a non-wildcard `Access-Control-Allow-Origin` per origin), while a controller
 * may add its own `Vary: Cookie`. Last-writer-wins would let one clobber the
 * other — dropping `Vary: Origin` reopens exactly the shared-cache cross-origin
 * leak the CORS policy set it to prevent. So the two are token-unioned
 * (comma lists on both sides, deduped case-insensitively, first-seen casing and
 * order preserved) into one canonical `Vary`. Every OTHER header keeps
 * last-writer-wins: an over `Content-Type` replaces the under one.
 *
 * Pure and total over a {@link HeaderMap}: a single string and a string list are
 * both handled, so a response whose header is already an array merges as cleanly
 * as a fresh one.
 */
export function mergeHeaders(under: HeaderMap, over: HeaderMap): HeaderMap {
  // The chosen value per lowercased name, plus the original-cased key it lives
  // under — so an over header replaces the under header under that same key
  // (no second case variant), and a Set-Cookie accumulates into one list.
  const byLower = new Map<string, { key: string; value: string | string[] }>();

  const put = (name: string, value: string | string[]): void => {
    const lower = name.toLowerCase();
    const existing = byLower.get(lower);

    // Set-Cookie is a multimap: a value already present accumulates with the new
    // one (under then over) instead of being overwritten — both cookies ride.
    if (lower === "set-cookie" && existing !== undefined) {
      byLower.set(lower, {
        key: existing.key,
        value: [...asList(existing.value), ...asList(value)],
      });

      return;
    }

    // Vary is token-unioned, not overwritten: both layers may name a request
    // header the response varies on (a CORS policy's `Origin`, a controller's
    // `Cookie`), and last-writer-wins would drop one — a shared-cache leak when
    // the dropped token is the policy's `Vary: Origin`.
    if (lower === "vary" && existing !== undefined) {
      byLower.set(lower, {
        key: existing.key,
        value: unionVary(existing.value, value),
      });

      return;
    }

    // Any other header: the new value wins, written under the key already chosen
    // for this name (so casing does not split it into two entries).
    byLower.set(lower, { key: existing?.key ?? name, value });
  };

  for (const [name, value] of Object.entries(under)) put(name, value);
  for (const [name, value] of Object.entries(over)) put(name, value);

  const merged: HeaderMap = {};

  for (const { key, value } of byLower.values()) {
    merged[key] = value;
  }

  return merged;
}

/** Normalize a header value to a list, so a single value and an array merge alike. */
function asList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Split a `Vary` header value into its individual tokens.
 *
 * A value is either a single comma-list string (`"Origin, Cookie"`) or an array
 * of them (a header already carried as a list). Each element is split on commas,
 * trimmed, and empties from stray/trailing commas dropped — so `"Origin, "`
 * yields just `["Origin"]`, never a phantom `""` that would pollute the union.
 */
function varyTokens(value: string | string[]): string[] {
  return asList(value)
    .flatMap((part) => part.split(","))
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Union two `Vary` values into one canonical comma-list.
 *
 * Case-insensitive dedup (HTTP field names are case-insensitive) that keeps the
 * FIRST-seen token — under's tokens first, then over's — so both order and
 * original casing are stable. The result is a single string, so it writes back
 * into the {@link HeaderMap} under one `Vary` key.
 */
function unionVary(under: string | string[], over: string | string[]): string {
  const seen = new Map<string, string>();

  for (const token of [...varyTokens(under), ...varyTokens(over)]) {
    const lower = token.toLowerCase();

    if (!seen.has(lower)) {
      seen.set(lower, token);
    }
  }

  return [...seen.values()].join(", ");
}

/** Merge the default headers under a response; the response's own headers win. */
export function withSecurityHeaders(
  response: AnyLestoResponse,
  defaults: Record<string, string> | false,
): AnyLestoResponse {
  if (defaults === false) return response;

  return { ...response, headers: mergeHeaders(defaults, response.headers) };
}

/** The CSP and COEP knobs {@link securityDefaults} folds into the base header map. */
export interface SecurityHeaderOptions {
  readonly csp?: { readonly policy: string; readonly mode: "enforce" | "report-only" } | undefined;

  readonly crossOriginEmbedderPolicy?: boolean | undefined;
}

/**
 * Fold the opt-in CSP and COEP knobs into a base security-header map.
 *
 * The base map (the defaults, a custom replacement, or `false`) decides the
 * always-on set; CSP and COEP are *additions* layered on top, present only when
 * configured. Returns `false` untouched when headers are disabled wholesale.
 *
 *   - CSP picks its header by mode: `Content-Security-Policy` to enforce,
 *     `Content-Security-Policy-Report-Only` to merely observe violations.
 *   - COEP adds `require-corp` only when explicitly enabled.
 */
export function securityDefaults(
  base: Record<string, string> | false,
  options: SecurityHeaderOptions,
): Record<string, string> | false {
  if (base === false) return false;

  const headers: Record<string, string> = { ...base };

  if (options.csp !== undefined) {
    const header =
      options.csp.mode === "report-only"
        ? "Content-Security-Policy-Report-Only"
        : "Content-Security-Policy";

    headers[header] = options.csp.policy;
  }

  if (options.crossOriginEmbedderPolicy === true) {
    headers[COEP_HEADER] = "require-corp";
  }

  return headers;
}

/**
 * Map a thrown value to its HTTP status.
 *
 * Recognizes a coded error by BRAND — {@link isLestoError}, a duck-type on the
 * process-global `@lesto/errors` brand — never by `instanceof`: a monorepo install
 * can carry two copies of `@lesto/errors` (the router/ui 0.1.3 mispin did), and an
 * error thrown from one copy is not `instanceof` the other's class, so an
 * `instanceof` gate here silently downgraded a coded 400/422/413/503 to a 500.
 * Then branches on the stable `code` (a `RuntimeError`'s, say), never on a message
 * or a concrete subclass — so this lives in `@lesto/web` without importing the
 * transport that raised it, and recognizes the same coded refusals on either
 * runtime. Anything else is a 500: an unexpected throw is ours to own with a
 * generic body, never a leak.
 */
export function statusForError(error: unknown): number {
  if (isLestoError(error)) {
    if (error.code === "RUNTIME_INVALID_JSON") return 400;
    if (error.code === "RUNTIME_INVALID_REQUEST_TARGET") return 400;
    if (error.code === "ROUTER_MALFORMED_PARAM") return 400;
    if (error.code === "WEB_VALIDATION_FAILED") return 422;
    if (error.code === "RUNTIME_BODY_TOO_LARGE") return 413;
    if (error.code === "RUNTIME_HANDLER_TIMEOUT") return 503;
    // The edge dispatch deadline (`@lesto/cloudflare`'s `timeoutMs`) is the edge
    // twin of `RUNTIME_HANDLER_TIMEOUT` — an overrun the server owns, freed with
    // a 503 — so it maps to the same status in this shared registry.
    if (error.code === "CLOUDFLARE_DISPATCH_TIMEOUT") return 503;
  }

  return 500;
}

/** The safe, internals-free body sent for each error status. */
export function bodyForStatus(status: number): string {
  if (status === 400) return "Bad Request";

  if (status === 422) return "Unprocessable Entity";

  if (status === 413) return "Payload Too Large";

  if (status === 503) return "Service Unavailable";

  return "Internal Server Error";
}
