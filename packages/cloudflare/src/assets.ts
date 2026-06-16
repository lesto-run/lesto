/**
 * Serve static assets first, the app second — the Worker-side front door.
 *
 * Cloudflare binds the prerendered static files to `env.ASSETS`, a fetcher that
 * answers a `Request` with the matching file or a 404. This composes that with
 * the app handler: try the assets binding, and on a 404 fall through to the
 * dispatcher. So the static marketing zone is served as files (cached at the
 * edge, no isolate spun up) while the dynamic zone runs the Worker — the same
 * static-then-dynamic split the node front door makes, expressed in Cloudflare's
 * primitives.
 */

/** The shape of Cloudflare's `env.ASSETS` binding — just a fetcher. */
export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

/**
 * The slice of Cloudflare's `ExecutionContext` an app handler may need — just
 * `waitUntil`, forwarded UNTOUCHED to the wrapped handler so the dynamic
 * fall-through can schedule its post-response work (e.g. an OTLP `waitUntil`
 * flush). Optional, so a node-shaped caller drives the wrapper with one argument.
 */
export interface AssetExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** A Worker fetch handler that may read the `ExecutionContext` (e.g. for `waitUntil`). */
export type AssetAppHandler = (request: Request, ctx?: AssetExecutionContext) => Promise<Response>;

/** The methods static assets answer; everything else belongs to the app. */
const ASSET_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * Compose an assets binding in front of an app `fetch` handler.
 *
 * Static assets only ever answer safe, bodyless reads — a `GET`/`HEAD` for a
 * file. So a write (a form `POST` to sign in, a `PUT`, a `DELETE`) goes
 * *straight to the app*: handing it to the assets binding gets a 405, and
 * returning that would swallow the request before the app ever saw it — the
 * exact bug that left a deployed sign-in form posting into the void.
 *
 * For a `GET`/`HEAD`, the binding is asked first; a hit (or a 304, a range) is
 * returned as-is, and only a 404 — "no such asset" — falls through to the app,
 * so a dynamic route is never shadowed by a missing file.
 *
 * The Worker `ExecutionContext` (`ctx`) is forwarded to the app handler on every
 * fall-through, so a dynamic route keeps its `ctx.waitUntil` — the seam the OTLP
 * flush rides on. The assets binding never needs it (a static hit does no
 * post-response work), so it is passed only to the app. Optional, so a node-shaped
 * caller drives the wrapper with one argument.
 */
export function withAssets(
  assets: AssetFetcher,
  handler: AssetAppHandler,
): (request: Request, ctx?: AssetExecutionContext) => Promise<Response> {
  return async (request, ctx) => {
    if (!ASSET_METHODS.has(request.method)) {
      return handler(request, ctx);
    }

    const asset = await assets.fetch(request);

    return asset.status === 404 ? handler(request, ctx) : asset;
  };
}
