/**
 * Transport-neutral response hardening — the security layer BOTH runtimes share.
 *
 * The node server (`@keel/runtime`) and the Cloudflare edge (`@keel/cloudflare`)
 * are two front doors to the *same* dispatcher, and a security posture that lives
 * in only one of them is a gap: the field's SSR CVEs again and again landed in an
 * adapter (a `Host` header trusted in the Express adapter, headers not stripped on
 * one path) rather than the shared core. So the pure pieces — default security
 * headers, the opt-in CSP/COEP knobs, and the error→status/body mapping — live
 * here in `@keel/web`, which both transports already depend on, and neither
 * reimplements them. The node-specific bits (socket reads, timeouts, ETag hashing
 * over `node:crypto`, the access log) stay in the runtime; everything a Worker can
 * and must also do is here.
 *
 * Pure and dependency-light: a function of a response (or an error) and a config,
 * so every branch is unit-testable without a socket or a `fetch` runtime.
 */

import { KeelError } from "@keel/errors";

import type { AnyKeelResponse } from "./types";

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
 * `type="application/json"` payload). NOT a default precisely because Keel's
 * island bootstrap currently inlines JSON, which `script-src 'self'` would block.
 */
export const RECOMMENDED_CSP =
  "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; upgrade-insecure-requests";

/** The header `require-corp` rides on when COEP is opted in. */
const COEP_HEADER = "Cross-Origin-Embedder-Policy";

/** Merge the default headers under a response; the response's own headers win. */
export function withSecurityHeaders(
  response: AnyKeelResponse,
  defaults: Record<string, string> | false,
): AnyKeelResponse {
  if (defaults === false) return response;

  return { ...response, headers: { ...defaults, ...response.headers } };
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
 * Branches on the stable `code` of a {@link KeelError} (a `RuntimeError` is one),
 * never on a message or a concrete subclass — so this lives in `@keel/web` without
 * importing the transport that raised it, and recognizes the same coded refusals
 * on either runtime. Anything else is a 500: an unexpected throw is ours to own
 * with a generic body, never a leak.
 */
export function statusForError(error: unknown): number {
  if (error instanceof KeelError) {
    if (error.code === "RUNTIME_INVALID_JSON") return 400;
    if (error.code === "RUNTIME_BODY_TOO_LARGE") return 413;
    if (error.code === "RUNTIME_HANDLER_TIMEOUT") return 503;
  }

  return 500;
}

/** The safe, internals-free body sent for each error status. */
export function bodyForStatus(status: number): string {
  if (status === 400) return "Bad Request";

  if (status === 413) return "Payload Too Large";

  if (status === 503) return "Service Unavailable";

  return "Internal Server Error";
}
