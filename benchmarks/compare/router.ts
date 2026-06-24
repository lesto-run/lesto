/**
 * The route-matching comparison: register the SAME route set in each router, then
 * resolve the SAME mixed request stream through each and time it.
 *
 *   - `lesto`        — `@lesto/router`'s `RouteTable` (a compiled-RegExp linear scan).
 *   - `find-my-way`  — Fastify's radix-tree router (the de-facto Node baseline).
 *
 * `find-my-way` is a declared `benchmarks/` dependency (installed by `bun install`
 * in `benchmarks/`); it is still imported DYNAMICALLY with a graceful skip, so the
 * comparison degrades to Lesto-alone rather than crashing if it is ever absent.
 * This is the one place the harness measures raw matching with no request/response
 * cost around it — the floor on per-request routing work.
 *
 * NOT strictly identical work: Lesto URL-decodes every captured param at match
 * time (`decodeURIComponent` per segment); `find-my-way` decodes lazily, only when
 * a path actually contains a `%`. On these un-encoded paths find-my-way does less —
 * a real asymmetry the report's note calls out. `router.test.ts` asserts the two
 * resolve every request to the SAME hit/miss, so the timing isn't comparing
 * different routing decisions.
 */

import { RouteTable } from "@lesto/router";

import type { SampleSource } from "@lesto/bench";

/** A representative route set: static roots, single params, nested params, and a deep path. */
export const ROUTES: ReadonlyArray<readonly [method: string, pattern: string]> = [
  ["GET", "/"],
  ["GET", "/about"],
  ["GET", "/posts"],
  ["POST", "/posts"],
  ["GET", "/posts/:id"],
  ["GET", "/posts/:id/edit"],
  ["GET", "/posts/:id/comments/:commentId"],
  ["GET", "/users/:userId"],
  ["GET", "/users/:userId/posts/:postId"],
  ["GET", "/api/v1/orders/:orderId/items/:itemId"],
  ["GET", "/docs/*rest"],
];

/**
 * The request stream every router resolves, per sample. A spread across static
 * hits, shallow and deep param hits, a catch-all, and one guaranteed miss — so
 * the number reflects realistic traffic, not one hot path. One `sample()`
 * resolves the whole stream, so every contender does identical work per sample.
 */
export const REQUESTS: ReadonlyArray<readonly [method: string, path: string]> = [
  ["GET", "/"],
  ["GET", "/about"],
  ["GET", "/posts"],
  ["POST", "/posts"],
  ["GET", "/posts/42"],
  ["GET", "/posts/42/edit"],
  ["GET", "/posts/42/comments/7"],
  ["GET", "/users/123"],
  ["GET", "/users/123/posts/456"],
  ["GET", "/api/v1/orders/1000/items/2000"],
  ["GET", "/docs/guide/getting-started"],
  ["GET", "/nope/not/a/route"],
];

/** A shared no-op handler — the matchers store it but never invoke it (we measure matching, not handling). */
const noop = (): void => {};

/**
 * A normalized resolver: `(method, path)` → the index of the matched route in
 * `ROUTES`, or `null` for a miss. Both routers expose this shape so `router.test.ts`
 * can assert they agree on every request (the charter's "identical work" rule —
 * the timing is only meaningful if both make the SAME routing decision).
 */
export type Resolve = (method: string, path: string) => number | null;

/** Build the Lesto matcher: a `RouteTable` storing each route's index as its value. */
export function buildLestoMatcher(): Resolve {
  const table = new RouteTable<number>();
  ROUTES.forEach(([method, pattern], i) => table.add(method, pattern, i));

  return (method, path) => table.match(method, path)?.value ?? null;
}

/** Build the find-my-way matcher, or `null` if the package is absent. Stores each route's index. */
export async function buildFindMyWayMatcher(): Promise<Resolve | null> {
  let factory: ((options?: unknown) => FindMyWayRouter) | undefined;
  try {
    const mod = (await import("find-my-way")) as {
      default: (options?: unknown) => FindMyWayRouter;
    };
    factory = mod.default;
  } catch {
    return null;
  }

  const router = factory();
  ROUTES.forEach(([method, pattern], i) => {
    // `find-my-way` uses `*` (not `*name`) for a wildcard; translate the one catch-all.
    // The 4th arg is the per-route `store`, where we stash the index for parity checks.
    router.on(method, pattern.replace(/\*\w+$/, "*"), noop, { i });
  });

  return (method, path) => {
    const found = router.find(method, path);

    return found ? found.store.i : null;
  };
}

/** A Lesto route-match sample: build the matcher once, resolve the full request stream per call. */
export function lestoRouterSample(): SampleSource {
  const resolve = buildLestoMatcher();

  return async () => {
    for (const [method, path] of REQUESTS) {
      resolve(method, path);
    }
  };
}

/** A `find-my-way` route-match sample, or `null` if the package is not installed. */
export async function findMyWayRouterSample(): Promise<SampleSource | null> {
  const resolve = await buildFindMyWayMatcher();
  if (!resolve) {
    return null;
  }

  return async () => {
    for (const [method, path] of REQUESTS) {
      resolve(method, path);
    }
  };
}

/** The slice of `find-my-way`'s surface this comparison touches. */
interface FindMyWayRouter {
  on(method: string, path: string, handler: () => void, store: { i: number }): void;
  find(method: string, path: string): { store: { i: number } } | null;
}
