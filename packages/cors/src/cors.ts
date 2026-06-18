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

export interface CorsOptions {
  /** Who may call us. `"*"` (the default) allows any origin. */
  origin?: "*" | string | string[];

  /** Methods advertised on `Access-Control-Allow-Methods`. */
  methods?: string[];

  /** Headers advertised on `Access-Control-Allow-Headers`. */
  headers?: string[];

  /**
   * Whether to send `Access-Control-Allow-Credentials: true`.
   *
   * Requires an explicit `origin` (a string or array allow-list). Pairing this
   * with the wildcard `"*"` throws {@link CorsError} `CORS_WILDCARD_WITH_CREDENTIALS`.
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
 * name the origins explicitly (a string or array allow-list), and only a member
 * of that list is ever echoed back.
 */
function resolveOrigin(
  requestOrigin: string | undefined,
  policy: "*" | string | string[],
): ResolvedOrigin {
  // Wildcard policy. Credentials with "*" never reaches here, so a plain "*"
  // is always safe to advertise — it can never be paired with credentials.
  if (policy === "*") {
    return { allowOrigin: "*" };
  }

  // Allow-list policy: echo the request origin only when it is a member.
  if (Array.isArray(policy)) {
    if (requestOrigin !== undefined && policy.includes(requestOrigin)) {
      return { allowOrigin: requestOrigin };
    }

    return { allowOrigin: undefined };
  }

  // Single exact-match policy: echo it only when the request matches.
  if (requestOrigin === policy) {
    return { allowOrigin: policy };
  }

  return { allowOrigin: undefined };
}

/**
 * Compute the `Access-Control-*` response headers for one request.
 *
 * @param requestOrigin the request's `Origin` header, or `undefined` if absent.
 * @param options the CORS policy. Omitted fields fall back to permissive defaults.
 * @returns a header map. Empty `{}` (no `Access-Control-Allow-Origin`) means deny.
 */
export function corsHeaders(
  requestOrigin: string | undefined,
  options: CorsOptions = {},
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

  if (options.headers !== undefined) {
    headers["Access-Control-Allow-Headers"] = options.headers.join(", ");
  }

  if (credentials) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  if (options.maxAge !== undefined) {
    headers["Access-Control-Max-Age"] = String(options.maxAge);
  }

  // The response varies by origin under any non-wildcard policy.
  if (variesByOrigin) {
    headers["Vary"] = "Origin";
  }

  return headers;
}
