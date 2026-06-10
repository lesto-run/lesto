/**
 * `secureStack` — the one composition that turns Keel's security batteries on.
 *
 * Before the pipeline existed, `@keel/cors`, `@keel/ratelimit`, and `@keel/csrf`
 * were dead code: built, tested, and unmountable. This bundles them into an
 * ordered middleware list an app drops into `createApp({ middleware })`.
 *
 * The order is deliberate and is the onion from outside in:
 *
 *   1. `cors` — outermost, so a preflight is answered before any work and the
 *      `Access-Control-*` headers wrap *every* inner response, including a 429
 *      or 403 (a browser can only read a cross-origin error if it carries CORS
 *      headers).
 *   2. `rateLimit` — a cheap gate next, so a flood is shed before it can reach
 *      the comparatively expensive CSRF crypto or a controller.
 *   3. `csrf` — innermost of the three, and present ONLY when configured. CORS
 *      and rate-limit are safe to enable for everyone; CSRF enforcement changes
 *      what a token-less request can do, so it is never on unless the app asks.
 *
 * The contract that protects every existing app: with `cors`/`rateLimit`
 * omitted the stack adds nothing in those slots, and with `csrf` omitted no CSRF
 * check runs at all — so a token-less POST keeps working exactly as today until
 * the app opts in.
 */

import { cors } from "@keel/cors";
import type { CorsOptions } from "@keel/cors";

import { rateLimit } from "@keel/ratelimit";
import type { RateLimitOptions } from "@keel/ratelimit";

import { csrf } from "@keel/csrf";
import type { CsrfOptions } from "@keel/csrf";

import type { Middleware } from "@keel/web";

/**
 * What goes into the secure stack. Every field is optional: an empty
 * `secureStack({})` is an empty pipeline — the no-op floor — and each present
 * field adds exactly its one middleware, in the fixed safe order.
 */
export interface SecureStackOptions {
  /**
   * CORS policy. Present → a `cors` middleware is added (answers preflight,
   * wraps responses). Absent → no CORS middleware, behavior unchanged.
   */
  readonly cors?: CorsOptions;

  /**
   * Rate-limit policy. Present → a `rateLimit` middleware is added, keyed by the
   * request-context client IP. Absent → no rate limiting.
   */
  readonly rateLimit?: RateLimitOptions;

  /**
   * CSRF policy. Present → a `csrf` middleware enforces tokens on state-changing
   * methods. Absent (the default) → NO CSRF enforcement, so a token-less request
   * is untouched. This is the opt-in switch; it is never flipped implicitly.
   */
  readonly csrf?: CsrfOptions;
}

/**
 * Compose the configured security middleware into an ordered list.
 *
 * Builds the list in the fixed `cors → rateLimit → csrf` order, including only
 * the middleware whose options were supplied. The result is a plain
 * `readonly Middleware[]` to hand to `createApp({ middleware })` — composable
 * with an app's own middleware (concatenate to add layers around or within).
 */
export function secureStack(options: SecureStackOptions): readonly Middleware[] {
  const middleware: Middleware[] = [];

  if (options.cors !== undefined) {
    middleware.push(cors(options.cors));
  }

  if (options.rateLimit !== undefined) {
    middleware.push(rateLimit(options.rateLimit));
  }

  // CSRF is last and conditional: enforcement only when explicitly configured.
  if (options.csrf !== undefined) {
    middleware.push(csrf(options.csrf));
  }

  return middleware;
}
