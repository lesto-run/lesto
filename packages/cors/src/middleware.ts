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

/** The preflight method a browser sends before a non-simple cross-origin request. */
const PREFLIGHT_METHOD = "OPTIONS";

/**
 * A CORS middleware for the given policy.
 *
 * Two jobs, both delegating the actual policy to {@link corsHeaders}:
 *
 *   - A preflight (`OPTIONS`) is answered here and now — a `204 No Content`
 *     carrying the computed `Access-Control-*` headers — without ever reaching
 *     a controller. The browser reads those headers to decide whether the real
 *     request is allowed; there is no body to send.
 *   - Any other method runs the rest of the stack, then has the same headers
 *     merged *under* its response, so the controller's own headers win a clash
 *     while still advertising the CORS policy to the browser.
 *
 * A denied origin yields an empty header map from {@link corsHeaders} (no
 * `Access-Control-Allow-Origin`), so the browser blocks the read — we add
 * nothing and let the controller's response through unchanged, exactly as a
 * same-origin request would flow.
 */
export function cors(options: CorsOptions = {}): Middleware {
  return async (request, next) => {
    const headers = corsHeaders(request.headers["origin"], options);

    // A preflight is the middleware's to answer: a bodiless 204 with the policy
    // headers. It never touches a controller — there is nothing to dispatch.
    if (request.method === PREFLIGHT_METHOD) {
      return { status: 204, headers, body: "" };
    }

    const response = await next();

    // Merge the CORS headers *under* the response so a controller that set its
    // own header for the same name still wins; the browser sees the policy.
    return { ...response, headers: { ...headers, ...response.headers } };
  };
}
