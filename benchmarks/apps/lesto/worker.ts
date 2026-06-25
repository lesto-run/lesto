/**
 * The Lesto benchmark app on Cloudflare Workers — Lesto's PRIMARY target (it's
 * edge-native), the runtime a Node-only comparison leaves out.
 *
 *   wrangler deploy                       # live deploy (functional + bundle size)
 *   wrangler dev --port <p>               # local workerd, the driver's edge load path
 *   wrangler deploy --dry-run --outdir …  # bundle only (size, no deploy)
 *
 * Lesto's dispatch is pure — `webApp.handle: (method, path) => LestoResponse`, no
 * `node:http`, no filesystem — so the Worker is the thin adapter `@lesto/cloudflare`
 * provides: `toFetchHandler` turns that handle into `fetch(Request) => Response`,
 * running the SAME transport-neutral hardening (per-request context, error boundary,
 * security headers) the node `serve` applies. The bench app has only the four dynamic
 * workload routes — no static assets (so no `withAssets`) and no DB (the routes never
 * query, so no D1/Hyperdrive binding). The routes come from `./app`, shared with the
 * node `server.ts`, so /plaintext, /json, /ssr, /realistic serve byte-identical bodies
 * on the edge and on node.
 */

import { toFetchHandler } from "@lesto/cloudflare";
import type { EdgeExecutionContext } from "@lesto/cloudflare";

import { webApp } from "./app";

// Call `handle` through an arrow so its `this` is preserved when passed to the
// adapter; the request `options` the adapter supplies satisfy `handle`'s optional shape.
const handler = toFetchHandler((method, path, options) => webApp.handle(method, path, options));

export default {
  // Workers call `fetch(request, env, ctx)`; forward only request + ctx to the adapter
  // (no bindings — env is unused). ctx is passed so a future OTLP flush could ride
  // `ctx.waitUntil`, exactly as the estate worker does.
  fetch(request: Request, _env: unknown, ctx: EdgeExecutionContext): Promise<Response> {
    return handler(request, ctx);
  },
};
