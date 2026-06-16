/**
 * @keel/cloudflare — run a Keel app on Cloudflare Workers.
 *
 * The dispatcher is pure, so the edge is a thin adapter:
 *
 *   import { dispatchSites } from "@keel/runtime";
 *   import { toFetchHandler, withAssets } from "@keel/cloudflare";
 *
 *   const dispatch = dispatchSites({ sites, handle, readStatic });
 *   const app = toFetchHandler(dispatch);
 *
 *   export default {
 *     fetch: (request, env) => withAssets(env.ASSETS, app)(request),
 *   };
 *
 * `wranglerConfig(plan, options)` generates the `wrangler.jsonc` that wires the
 * Worker to its static-assets binding with `nodejs_compat` on.
 */

export { toFetchHandler } from "./fetch-handler";
export type {
  EdgeAccessEntry,
  EdgeDispatch,
  EdgeExecutionContext,
  EdgeInboundTrace,
  EdgeOptions,
  EdgeRequestOptions,
  EdgeRequestSpan,
  EdgeRequestTracer,
  EdgeTraceparentParser,
} from "./fetch-handler";

export { withAssets } from "./assets";
export type { AssetAppHandler, AssetExecutionContext, AssetFetcher } from "./assets";

export { serializeWranglerConfig, wranglerConfig } from "./wrangler";
export type {
  WranglerComments,
  WranglerConfig,
  WranglerD1Database,
  WranglerOptions,
  WranglerPlacement,
} from "./wrangler";

export { CloudflareError } from "./errors";
export type { CloudflareErrorCode } from "./errors";
