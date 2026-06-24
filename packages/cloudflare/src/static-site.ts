/**
 * The edge front door for a fully prerendered ("static") site.
 *
 * The whole site is a tree of files written at build time, so the Worker does
 * almost nothing: {@link withAssets} serves a matching static file straight from
 * the `ASSETS` binding (cached at the edge, no isolate spun up), and only a
 * genuine miss falls through to a 404. That 404 is routed through
 * {@link toFetchHandler} purely so it carries the framework's default security
 * headers — the same hardening the node server applies — even though no app,
 * database, or content engine runs on the edge.
 *
 * A static marketing/docs site's `worker.ts` collapses to one call:
 *
 *   import { staticAssetsWorker } from "@lesto/cloudflare";
 *   import { renderNotFound } from "./src/not-found";
 *   export default staticAssetsWorker({ notFound: renderNotFound });
 */

import { withAssets, type AssetExecutionContext, type AssetFetcher } from "./assets";
import { toFetchHandler } from "./fetch-handler";

/** The binding a static-assets Worker needs: Cloudflare's static-assets fetcher. */
export interface StaticAssetsEnv {
  /** Cloudflare's static-assets binding — the prerendered output tree. */
  readonly ASSETS: AssetFetcher;
}

/** The inputs to a static-assets Worker. */
export interface StaticAssetsWorkerOptions {
  /** Render the 404 body — a self-contained HTML string — for a path that matches no asset. */
  readonly notFound: () => string;
}

/** A Worker module's default export: the `fetch` entry wrangler invokes. */
export interface StaticAssetsWorker {
  fetch(request: Request, env: StaticAssetsEnv, ctx: AssetExecutionContext): Promise<Response>;
}

/**
 * Build the default export for a prerendered site's Worker: serve a matching asset
 * from the `ASSETS` binding, and render `notFound()` as a hardened 404 on a miss.
 */
export function staticAssetsWorker(options: StaticAssetsWorkerOptions): StaticAssetsWorker {
  const notFound = toFetchHandler(() =>
    Promise.resolve({
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: options.notFound(),
    }),
  );

  return {
    fetch(request: Request, env: StaticAssetsEnv, ctx: AssetExecutionContext): Promise<Response> {
      return withAssets(env.ASSETS, notFound)(request, ctx);
    },
  };
}
