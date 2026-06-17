/**
 * The CORS middleware adapter — wires the pure {@link corsHeaders} computation
 * into the request pipeline.
 *
 * The decision (which `Access-Control-*` headers a given origin earns) stays in
 * `corsHeaders`, untouched and fully tested on its own. This adapter is only the
 * plumbing: read the request's `Origin`, compute the headers, and either answer
 * a preflight outright or fold the headers onto the real response on the way out.
 */

import type { Middleware } from "@keel/web";

import { corsHeaders } from "./cors";
import type { CorsOptions } from "./cors";

/** The method a browser sends on a CORS preflight. */
const PREFLIGHT_METHOD = "OPTIONS";

/**
 * The request header that MAKES an OPTIONS a preflight.
 *
 * A real CORS preflight is an `OPTIONS` that the browser tags with
 * `Access-Control-Request-Method` (the method the real request will use). An
 * `OPTIONS` *without* it is not a preflight — it is an ordinary OPTIONS (a
 * capability probe, a health check, a WebDAV verb) that the app may want to
 * handle itself. Answering every OPTIONS with a bodiless 204 would swallow those
 * legitimate requests, so we gate the preflight short-circuit on this header.
 */
const PREFLIGHT_HEADER = "access-control-request-method";

/**
 * A CORS middleware for the given policy.
 *
 * Two jobs, both delegating the actual policy to {@link corsHeaders}:
 *
 *   - A *preflight* — an `OPTIONS` carrying `Access-Control-Request-Method` — is
 *     answered here and now: a `204 No Content` with the computed
 *     `Access-Control-*` headers, never reaching a controller. The browser reads
 *     those headers to decide whether the real request is allowed; there is no
 *     body to send.
 *   - Any other method (including a bare `OPTIONS` with no
 *     `Access-Control-Request-Method`, which is not a preflight) runs the rest of
 *     the stack, then has the same headers merged *under* its response — so the
 *     controller's own headers win a clash while the CORS policy is still
 *     advertised to the browser.
 *
 * A denied origin yields no `Access-Control-Allow-Origin` from {@link corsHeaders}
 * (only a `Vary: Origin` under a non-wildcard policy), so the browser blocks the
 * read — the controller's response flows through, exactly as a same-origin
 * request would.
 */
export function cors(options: CorsOptions = {}): Middleware {
  return async (request, next) => {
    const headers = corsHeaders(request.headers["origin"], options);

    // A preflight is the middleware's to answer: a bodiless 204 with the policy
    // headers. It is an OPTIONS that the browser tagged with the request-method
    // header — a bare OPTIONS without it is NOT a preflight and falls through to
    // the stack like any other method.
    const isPreflight =
      request.method === PREFLIGHT_METHOD && request.headers[PREFLIGHT_HEADER] !== undefined;

    if (isPreflight) {
      return { status: 204, headers, body: "" };
    }

    const response = await next();

    // Merge the CORS headers *under* the response so a controller that set its
    // own header for the same name still wins; the browser sees the policy.
    return { ...response, headers: { ...headers, ...response.headers } };
  };
}
