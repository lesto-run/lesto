/**
 * The Cloudflare Worker — the marketing site's edge front door.
 *
 * The site is fully prerendered (`build.ts` writes `out/www/`), so the Worker
 * does almost nothing: `withAssets` serves a matching static file straight from
 * the `ASSETS` binding (cached at the edge, no isolate spun up), and only a
 * genuine miss falls through to the handler — which renders a 404. That handler
 * goes through `toFetchHandler` purely so the 404 carries the framework's
 * default security headers, the same hardening the node server applies.
 *
 * There is no app, no database, and no content engine on the edge: this file
 * imports only the assets adapter and a static 404 string.
 */

import { toFetchHandler, withAssets } from "@lesto/cloudflare";
import type { AssetExecutionContext, AssetFetcher } from "@lesto/cloudflare";

import { renderNotFound } from "./src/not-found";

interface Env {
  /** Cloudflare's static-assets binding — the prerendered `out/www/` tree. */
  readonly ASSETS: AssetFetcher;
}

const notFound = toFetchHandler(() =>
  Promise.resolve({
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: renderNotFound(),
  }),
);

export default {
  fetch(request: Request, env: Env, ctx: AssetExecutionContext): Promise<Response> {
    return withAssets(env.ASSETS, notFound)(request, ctx);
  },
};
