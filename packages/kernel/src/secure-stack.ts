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
 *   3. `originCheck` — the header-based CSRF defense, before the token check so a
 *      forged cross-site request is refused before any crypto runs. Present only
 *      when configured.
 *   4. `csrf` — innermost, the signed-token check, present ONLY when configured.
 *      CORS and rate-limit are safe to enable for everyone; the CSRF checks change
 *      what a token-less / cross-site request can do, so neither is on unless the
 *      app asks.
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

import { csrf, originCheck } from "@keel/csrf";
import type { CsrfOptions, OriginCheckOptions } from "@keel/csrf";

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
   * Origin / Fetch-Metadata CSRF check. Present → an `originCheck` middleware
   * refuses cross-site state-changing requests by reading `Sec-Fetch-Site` (and
   * `Origin` as a fallback) — no token plumbing required. The cheap, recommended
   * CSRF default; `{ originCheck: {} }` is enough for modern browsers. Absent →
   * no origin check. Pair it with {@link csrf} for defense in depth, or use it
   * alone where the token machinery isn't yet wired.
   */
  readonly originCheck?: OriginCheckOptions;

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

  // The two CSRF defenses sit innermost, both conditional. The cheap header-based
  // origin check runs first (it sheds a forged cross-site request before the
  // token crypto), then the signed-token check.
  if (options.originCheck !== undefined) {
    middleware.push(originCheck(options.originCheck));
  }

  // CSRF token is last and conditional: enforcement only when explicitly configured.
  if (options.csrf !== undefined) {
    middleware.push(csrf(options.csrf));
  }

  return middleware;
}
