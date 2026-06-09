/**
 * CORS header computation — pure, with one coded config guard.
 *
 * Given the request's `Origin` and a policy, resolve the `Access-Control-*`
 * response headers a server should send. Deciding is separated from any I/O:
 * this is a plain function of its inputs, fully testable with no clock, no
 * socket, no framework.
 */

import { KeelError } from "@keel/errors";

export type CorsErrorCode = "CORS_WILDCARD_WITH_CREDENTIALS";

/**
 * A misconfigured CORS policy. Carries a stable `code` so callers branch on the
 * machine-readable reason, never the prose.
 */
export class CorsError extends KeelError<CorsErrorCode> {
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
 * The resolved allowed origin, plus whether it was *echoed* (a specific origin)
 * rather than the wildcard. We add `Vary: Origin` only when the response
 * depends on the request's origin — i.e. when we echoed it.
 */
interface ResolvedOrigin {
  /** The value for `Access-Control-Allow-Origin`, or `undefined` to deny. */
  allowOrigin: string | undefined;

  /** True when `allowOrigin` is the request's own origin, not `"*"`. */
  echoed: boolean;
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
    return { allowOrigin: "*", echoed: false };
  }

  // Allow-list policy: echo the request origin only when it is a member.
  if (Array.isArray(policy)) {
    if (requestOrigin !== undefined && policy.includes(requestOrigin)) {
      return { allowOrigin: requestOrigin, echoed: true };
    }

    return { allowOrigin: undefined, echoed: false };
  }

  // Single exact-match policy: echo it only when the request matches.
  if (requestOrigin === policy) {
    return { allowOrigin: policy, echoed: true };
  }

  return { allowOrigin: undefined, echoed: false };
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

  const { allowOrigin, echoed } = resolveOrigin(requestOrigin, policy);

  // A denied origin gets no headers at all — the browser will block the read.
  if (allowOrigin === undefined) {
    return {};
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

  // The response varies by origin only when we reflected a specific one.
  if (echoed) {
    headers["Vary"] = "Origin";
  }

  return headers;
}
