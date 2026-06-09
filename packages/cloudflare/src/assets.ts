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
 * Compose an assets binding in front of an app `fetch` handler.
 *
 * Returns a handler that asks the assets binding first; any answer other than a
 * 404 (a hit, a redirect, a range response) is returned as-is, and only a 404 —
 * "no such asset" — falls through to the app.
 */
export function withAssets(
  assets: AssetFetcher,
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const asset = await assets.fetch(request);

    return asset.status === 404 ? handler(request) : asset;
  };
}
