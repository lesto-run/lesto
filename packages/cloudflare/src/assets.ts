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
 */
export function withAssets(
  assets: AssetFetcher,
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!ASSET_METHODS.has(request.method)) {
      return handler(request);
    }

    const asset = await assets.fetch(request);

    return asset.status === 404 ? handler(request) : asset;
  };
}
