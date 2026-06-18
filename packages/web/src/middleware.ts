/**
 * The request middleware pipeline — an onion around controller dispatch.
 *
 * A middleware wraps the rest of the stack: it receives the request and a
 * `next` it may call (and `await`) to run the inner layers, then shapes the
 * response on the way back out. Composed, they form the classic onion model —
 * the first-listed middleware is the outermost layer, seeing the request first
 * and the response last. This is the interception point Lesto lacked, the one
 * that finally lets `@lesto/cors`, `@lesto/ratelimit`, `@lesto/csrf` mount.
 *
 * The load-bearing backward-compatibility property: an *empty* middleware list
 * runs the controller dispatch and nothing else, so an app that configures no
 * middleware behaves exactly as it did before this pipeline existed.
 */

import type { AnyLestoResponse, LestoRequest } from "./types";

/**
 * The terminal step a middleware calls to run the inner layers — ultimately the
 * controller. A middleware that never calls `next` short-circuits the stack
 * (a rate-limit 429, a CSRF 403, a CORS preflight answer), and one that calls it
 * may inspect or replace the response it returns.
 */
export type Next = () => Promise<AnyLestoResponse>;

/**
 * One layer of the onion: given the request and the `next` step, produce a
 * response. It may answer outright (skip `next`), delegate (`await next()`),
 * or delegate and then adjust the result (add headers, swap the body).
 */
export type Middleware = (request: LestoRequest, next: Next) => Promise<AnyLestoResponse>;

/**
 * Fold an ordered middleware list around a terminal dispatch.
 *
 * Build the chain from the inside out so the *first* middleware ends up
 * outermost: start with `dispatch` as the innermost `next`, then wrap it with
 * each middleware from last to first. The returned promise is what the outermost
 * layer produces. With an empty list this is `dispatch()` verbatim — no wrapper,
 * no overhead, identical behavior to a pipeline-free dispatch.
 *
 * Pure and exported so every shape — empty, single, ordering, short-circuit —
 * is unit-testable without a controller or a socket.
 */
export function runPipeline(
  middleware: readonly Middleware[],
  request: LestoRequest,
  dispatch: Next,
): Promise<AnyLestoResponse> {
  // reduceRight wraps from the inside out: the accumulator is the `next` the
  // current layer will call, seeded with the terminal dispatch.
  const chain = middleware.reduceRight<Next>((next, layer) => () => layer(request, next), dispatch);

  return chain();
}
