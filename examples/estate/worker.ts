/**
 * The Cloudflare Worker entry — the estate site on the edge.
 *
 *   wrangler deploy
 *
 * Keel's dispatcher is pure, so the Worker is a thin adapter (ADR 0002):
 * `toFetchHandler` turns the app's `handle` into `fetch(Request) => Response`,
 * and `withAssets` serves the prerendered marketing files from the Static Assets
 * binding first, falling through to the live app for `/mls`. The session is a
 * stateless signed token, so auth works across ephemeral isolates with no store.
 *
 * `env.SESSION_SECRET` is a wrangler secret (`wrangler secret put SESSION_SECRET`),
 * never committed — it is the trust root for every signed session.
 */

import { toFetchHandler, withAssets } from "@keel/cloudflare";
import type { AssetFetcher } from "@keel/cloudflare";

import { buildEdgeApp, edgeSecret } from "./src/edge";

/** The bindings this Worker is configured with (see wrangler.jsonc). */
interface Env {
  readonly ASSETS: AssetFetcher;
  readonly SESSION_SECRET?: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const app = buildEdgeApp(edgeSecret(env));

    const handler = toFetchHandler((method, path, options) => app.handle(method, path, options));

    // Static marketing files first (cached at the PoP); the live app for the rest.
    return withAssets(env.ASSETS, handler)(request);
  },
};
