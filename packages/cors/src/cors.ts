/**
 * CORS header computation — pure, with one coded config guard.
 *
 * Given the request's `Origin` and a policy, resolve the `Access-Control-*`
 * response headers a server should send. Deciding is separated from any I/O:
 * this is a plain function of its inputs, fully testable with no clock, no
 * socket, no framework.
 */

import { LestoError } from "@lesto/errors";

export type CorsErrorCode = "CORS_WILDCARD_WITH_CREDENTIALS";

/**
 * A misconfigured CORS policy. Carries a stable `code` so callers branch on the
 * machine-readable reason, never the prose.
 */
export class CorsError extends LestoError<CorsErrorCode> {
  constructor(code: CorsErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "CorsError";
  }
}

/**
 * A predicate over the request's `Origin`: return `true` to allow it.
 *
 * The escape hatch for a policy no static list can express — a per-tenant
 * subdomain, an allow-list read from a config store, "any `*.example.com`".
 * When it approves an origin we echo *that exact origin* back (never `"*"`), so
 * it composes with credentials the way an allow-list does — you own getting the
 * predicate right.
 */
export type CorsOriginPredicate = (origin: string) => boolean;

/**
 * Who may call us.
 *
 *   - `"*"` (the default) — any origin. Cannot be paired with credentials.
 *   - a string — one exact origin.
 *   - a string[] — an allow-list of exact origins.
 *   - a `RegExp` — echo the origin when the pattern matches it.
 *   - a {@link CorsOriginPredicate} — echo the origin when the callback approves.
 *
 * Every non-wildcard form echoes back only an origin it approved, so the
 * response is origin-dependent and rides `Vary: Origin`.
 */
export type CorsOrigin = "*" | string | string[] | RegExp | CorsOriginPredicate;

export interface CorsOptions {
  /** Who may call us. `"*"` (the default) allows any origin. See {@link CorsOrigin}. */
  origin?: CorsOrigin;

  /** Methods advertised on `Access-Control-Allow-Methods`. */
  methods?: string[];

  /**
   * Headers advertised on `Access-Control-Allow-Headers`.
   *
   * A *static* allow-list. When omitted, a preflight reflects the browser's
   * `Access-Control-Request-Headers` instead (see {@link corsHeaders}), so the
   * common case — a cross-origin JSON fetch preflighting `Content-Type` — works
   * with no configuration. Set this to pin the surface to a fixed list.
   */
  headers?: string[];

  /**
   * Response headers to reveal to the caller's script via
   * `Access-Control-Expose-Headers`.
   *
   * Without this a browser hides every response header from a cross-origin read
   * except the CORS-safelisted few, so a client cannot read a custom
   * `X-Total-Count` / `X-Request-Id` it can see on a same-origin request. Names
   * listed here are exposed to `fetch`/`XMLHttpRequest`.
   */
  exposeHeaders?: string[];

  /**
   * Whether to send `Access-Control-Allow-Credentials: true`.
   *
   * Requires an explicit `origin` (a string, array, `RegExp`, or predicate —
   * anything but `"*"`). Pairing this with the wildcard `"*"` throws
   * {@link CorsError} `CORS_WILDCARD_WITH_CREDENTIALS`.
   */
  credentials?: boolean;

  /** Preflight cache lifetime, in seconds, for `Access-Control-Max-Age`. */
  maxAge?: number;
}

/** The methods we advertise when the policy names none. A sensible REST default. */
const DEFAULT_METHODS: readonly string[] = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"];

/**
 * The resolved allowed origin. We add `Vary: Origin` whenever the *policy* is
 * non-wildcard — i.e. whenever the response could differ by the request's origin
 * (a member is echoed and allowed, a non-member gets nothing), so a shared cache
 * keyed on URL alone can never serve one origin's CORS response to another. The
 * caller derives that from `policy === "*"`, so this carries only the value.
 */
interface ResolvedOrigin {
  /** The value for `Access-Control-Allow-Origin`, or `undefined` to deny. */
  allowOrigin: string | undefined;
}

/**
 * Resolve `Access-Control-Allow-Origin` from the policy and the request origin.
 *
 * Wildcard is the default. `"*"` plus credentials is rejected before we get
 * here (see `corsHeaders`), because reflecting an arbitrary `Origin` with
 * `Access-Control-Allow-Credentials: true` is a credentialed-CORS bypass — any
 * site could then read authenticated responses. To allow credentials you must
 * name the origins explicitly (a string, array, `RegExp`, or predicate), and
 * only an origin that policy approves is ever echoed back.
 */
function resolveOrigin(requestOrigin: string | undefined, policy: CorsOrigin): ResolvedOrigin {
  // Wildcard policy. Credentials with "*" never reaches here, so a plain "*"
  // is always safe to advertise — it can never be paired with credentials.
  if (policy === "*") {
    return { allowOrigin: "*" };
  }

  // Every remaining form is an allow-list that echoes back the *presented*
  // origin. A request with no `Origin` can match none of them — we never test a
  // policy against `undefined`, and never echo a header for an absent origin.
  if (requestOrigin === undefined) {
    return { allowOrigin: undefined };
  }

  // Array allow-list: echo the request origin only when it is a member.
  if (Array.isArray(policy)) {
    return { allowOrigin: policy.includes(requestOrigin) ? requestOrigin : undefined };
  }

  // Regex allow-list: echo the origin when the pattern matches it. Test on a
  // stateless copy — a `/g` or `/y` source carries mutable `lastIndex` across
  // calls, so reusing the caller's regex would flip its verdict on alternate
  // requests. Dropping those flags makes each request an independent match.
  if (policy instanceof RegExp) {
    const stateless = new RegExp(policy.source, policy.flags.replace(/[gy]/g, ""));

    return { allowOrigin: stateless.test(requestOrigin) ? requestOrigin : undefined };
  }

  // Predicate allow-list: echo the origin when the callback approves it.
  if (typeof policy === "function") {
    return { allowOrigin: policy(requestOrigin) ? requestOrigin : undefined };
  }

  // Single exact-match string policy: echo it only when the request matches.
  return { allowOrigin: requestOrigin === policy ? policy : undefined };
}

/**
 * Compute the `Access-Control-*` response headers for one request.
 *
 * @param requestOrigin the request's `Origin` header, or `undefined` if absent.
 * @param options the CORS policy. Omitted fields fall back to permissive defaults.
 * @param requestedHeaders the request's `Access-Control-Request-Headers` header
 *   (the header list a preflight announces), or `undefined` when absent. With no
 *   static {@link CorsOptions.headers} allow-list, this value is reflected into
 *   `Access-Control-Allow-Headers` so a browser's preflight — the one a
 *   cross-origin JSON `fetch` fires for `Content-Type` — is not rejected out of
 *   the box. It is meaningful only on a preflight; a real request omits it.
 * @returns a header map. Empty `{}` (no `Access-Control-Allow-Origin`) means deny.
 */
export function corsHeaders(
  requestOrigin: string | undefined,
  options: CorsOptions = {},
  requestedHeaders?: string | undefined,
): Record<string, string> {
  const policy = options.origin ?? "*";
  const credentials = options.credentials ?? false;

  // Fail loud, at config time, on the one combination the Fetch standard forbids:
  // a wildcard origin with credentials. Silently reflecting `Origin` here would
  // let any site read authenticated responses. To use credentials, name origins.
  if (credentials && policy === "*") {
    throw new CorsError(
      "CORS_WILDCARD_WITH_CREDENTIALS",
      'CORS origin "*" cannot be combined with credentials: true. ' +
        "Specify an explicit origin or allow-list so credentialed responses are never exposed to arbitrary sites.",
    );
  }

  const { allowOrigin } = resolveOrigin(requestOrigin, policy);

  // Whenever the policy is non-wildcard the response is origin-dependent — a
  // member gets headers, a non-member gets none — so `Vary: Origin` MUST ride on
  // BOTH outcomes. Without it on the deny path, a shared cache keyed on URL alone
  // could store one origin's response and replay it to a different origin: serve
  // the allowed origin's `Access-Control-Allow-Origin` to an outsider, or cache
  // the empty deny over an allowed origin's hit. A `"*"` policy is the same for
  // every origin, so it needs no `Vary`.
  const variesByOrigin = policy !== "*";

  // A denied origin gets no Access-Control-* headers — the browser blocks the
  // read — but still carries `Vary: Origin` so the deny is not cached
  // cross-origin. A denial only ever happens under a non-wildcard policy (the
  // wildcard always resolves to `"*"` and never denies), so the deny path varies
  // by origin unconditionally.
  if (allowOrigin === undefined) {
    return { Vary: "Origin" };
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": (options.methods ?? DEFAULT_METHODS).join(", "),
  };

  // `Access-Control-Allow-Headers`. A static allow-list, when configured, pins
  // the surface to exactly those names. Otherwise reflect what the preflight
  // asked for: without this, the default policy sends no allow-headers at all,
  // and a cross-origin JSON fetch — which preflights `Content-Type` — is blocked
  // out of the box. A reflected value is request-dependent, so it rides `Vary`.
  let reflectsRequestHeaders = false;

  if (options.headers !== undefined) {
    headers["Access-Control-Allow-Headers"] = options.headers.join(", ");
  } else if (requestedHeaders !== undefined) {
    headers["Access-Control-Allow-Headers"] = requestedHeaders;
    reflectsRequestHeaders = true;
  }

  // What the browser may reveal to the caller's script beyond the safelisted few.
  if (options.exposeHeaders !== undefined) {
    headers["Access-Control-Expose-Headers"] = options.exposeHeaders.join(", ");
  }

  if (credentials) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  if (options.maxAge !== undefined) {
    headers["Access-Control-Max-Age"] = String(options.maxAge);
  }

  // `Vary` names every request header this response was computed from, so a
  // shared cache keyed on URL alone can never replay one caller's response to
  // another: `Origin` under any non-wildcard policy, and
  // `Access-Control-Request-Headers` whenever the allow-headers were reflected
  // from it (including under the wildcard default).
  const varyOn: string[] = [];

  if (variesByOrigin) {
    varyOn.push("Origin");
  }

  if (reflectsRequestHeaders) {
    varyOn.push("Access-Control-Request-Headers");
  }

  if (varyOn.length > 0) {
    headers["Vary"] = varyOn.join(", ");
  }

  return headers;
}
