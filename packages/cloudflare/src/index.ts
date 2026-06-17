/**
 * @keel/cloudflare — run a Keel app on Cloudflare Workers.
 *
 * A Keel app's `handle` is already a pure `(method, path, options) => KeelResponse`
 * with no node:http and no filesystem, so the edge is a thin adapter:
 * `toFetchHandler` turns that `handle` into a Worker `fetch(Request) => Response`,
 * and `withAssets` serves the prerendered static files from the platform's Static
 * Assets binding first, falling through to the live app for the dynamic zone.
 *
 *   import { toFetchHandler, withAssets } from "@keel/cloudflare";
 *   import type { AssetFetcher } from "@keel/cloudflare";
 *
 *   interface Env { readonly ASSETS: AssetFetcher; readonly SESSION_SECRET?: string }
 *
 *   export default {
 *     // `ctx` (the Worker ExecutionContext) is forwarded so a request's OTLP
 *     // flush rides through `ctx.waitUntil` — see `toFetchHandler`'s `flush`.
 *     fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
 *       const app = toFetchHandler(buildApp(env).handle);
 *
 *       return withAssets(env.ASSETS, app)(request, ctx);
 *     },
 *   };
 *
 * That is the pattern `examples/estate/worker.ts` actually deploys (the app is
 * memoized at module scope per isolate, not rebuilt per request). Note it does NOT
 * import `@keel/runtime`'s `dispatchSites`: that helper reads the filesystem
 * through node's `fs`, which a Worker has none of — the edge serves static bytes
 * through the `ASSETS` binding (`withAssets`) instead, and runs only the dynamic
 * app's `handle`.
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

export { d1ToSqlDatabase } from "./d1";
export type { D1Database, D1PreparedStatement } from "./d1";

export { CloudflareError } from "./errors";
export type { CloudflareErrorCode } from "./errors";
