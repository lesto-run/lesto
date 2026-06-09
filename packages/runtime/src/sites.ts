/**
 * Path-mount serving: one origin, many sites, dispatched by path prefix.
 *
 * A Keel deployment serves a *set* of sites from a single origin — a marketing
 * site at `/`, an authed app at `/mls` — so they share an origin and therefore a
 * same-origin session. This dispatcher is the front door: it picks the site that
 * owns the request path, then serves it. Dynamic sites delegate to the live app;
 * static sites read their prerendered file off a sink.
 *
 * It is deliberately pure. The one thing that varies — reading a static file —
 * is injected as `readStatic`, so the whole decision tree is testable against a
 * fake map with no disk. The real filesystem reader ({@link nodeStaticReader})
 * is a thin, separately-tested adapter over that same shape.
 */

import { outputPath } from "@keel/sites";
import type { Site } from "@keel/sites";

import type { KeelResponse } from "@keel/web";

/** Reads a prerendered file's contents, or `undefined` if it is not there. */
export type StaticReader = (filePath: string) => Promise<string | undefined>;

/** The per-request inputs a dynamic site needs threaded through to it. */
export interface RequestOptions {
  readonly query?: Record<string, string>;

  readonly headers?: Record<string, string>;

  readonly body?: unknown;
}

/**
 * The live app's request handler, for dynamic sites.
 *
 * It takes the request options (query, headers, body) and returns the *full*
 * {@link KeelResponse} — status, headers, and body — which the dispatcher passes
 * through verbatim in both directions. That is load-bearing: a dynamic zone
 * reads the session cookie from the request `headers` and sets it via the
 * response `Set-Cookie`, so neither may be dropped. `App.handle` from
 * `@keel/kernel` satisfies this exactly.
 */
export type AppHandler = (
  method: string,
  path: string,
  options?: RequestOptions,
) => Promise<KeelResponse>;

/** Everything the site dispatcher needs, injected so the core stays pure. */
export interface DispatchSitesDeps {
  /** The mounted sites, in any order — selection is by longest matching prefix. */
  readonly sites: readonly Site[];

  /** The live app's request handler, for dynamic sites. Pass `app.handle`. */
  readonly handle: AppHandler;

  /** Reads a prerendered static file by its output path. */
  readonly readStatic: StaticReader;
}

/** The methods a static site answers; anything else is a 405. */
const STATIC_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * Pick a `Content-Type` from a file's extension.
 *
 * Prerendered files are pages and a handful of endpoints (`sitemap.xml`,
 * `robots.txt`, a JSON feed). Anything unrecognized is HTML — the overwhelming
 * common case, since a clean-URL page is always `index.html`.
 */
function contentTypeOf(filePath: string): string {
  if (filePath.endsWith(".xml")) return "application/xml";

  if (filePath.endsWith(".txt")) return "text/plain; charset=utf-8";

  if (filePath.endsWith(".json")) return "application/json";

  return "text/html; charset=utf-8";
}

/**
 * Select the site that owns a request path.
 *
 * The winner is the site whose `basePath` is the *longest* prefix of the path
 * that lands on a segment boundary — so `/mls/x` picks `mls` over the root, and
 * a `basePath` of `/ml` never claims `/mls`. `basePath: "/"` is the catch-all,
 * matching anything no more specific site has claimed.
 */
function selectSite(sites: readonly Site[], path: string): Site | undefined {
  let best: Site | undefined;

  for (const site of sites) {
    const { basePath } = site;

    // The root mount matches every path; it is the floor everything falls to.
    const matches = basePath === "/" || path === basePath || path.startsWith(`${basePath}/`);

    if (!matches) continue;

    // Longer basePath wins; the root's length of 1 loses to any real zone.
    if (best === undefined || basePath.length > best.basePath.length) {
      best = site;
    }
  }

  return best;
}

/**
 * Strip a site's `basePath` from a path to get the route *within* the site.
 *
 *   ("/mls", "/mls/about") -> "/about"
 *   ("/mls", "/mls")       -> "/"
 *   ("/",    "/about")     -> "/about"
 *   ("/",    "/")          -> "/"
 */
function routeWithin(basePath: string, path: string): string {
  if (basePath === "/") return path;

  const rest = path.slice(basePath.length);

  // `/mls` exactly leaves nothing; that is the site's own root, `/`.
  return rest === "" ? "/" : rest;
}

/** A bare-bones response with no body — for the error statuses. */
function emptyResponse(status: number): KeelResponse {
  return { status, headers: {}, body: "" };
}

/** Serve a static site: only GET/HEAD, mapping the route to its prerendered file. */
async function serveStatic(
  site: Site,
  method: string,
  path: string,
  readStatic: StaticReader,
): Promise<KeelResponse> {
  if (!STATIC_METHODS.has(method)) return emptyResponse(405);

  const route = routeWithin(site.basePath, path);

  // Build and serve must agree on where a route's file lives, so both call
  // `outputPath` from @keel/sites — the single source of that mapping.
  const file = outputPath(site.name, route);

  const body = await readStatic(file);

  if (body === undefined) return emptyResponse(404);

  return {
    status: 200,
    headers: { "content-type": contentTypeOf(file) },
    body,
  };
}

/**
 * Build the path-mount dispatcher over a set of sites.
 *
 * Returns a handler `(method, path) -> response`: select the owning site, then
 * delegate (dynamic) or read its prerendered file (static). No owning site is a
 * 404 — the request belongs to no mounted zone.
 */
export function dispatchSites(
  deps: DispatchSitesDeps,
): (method: string, path: string, options?: RequestOptions) => Promise<KeelResponse> {
  const { sites, handle, readStatic } = deps;

  return async (method, path, options) => {
    const site = selectSite(sites, path);

    if (site === undefined) return emptyResponse(404);

    // A dynamic zone delegates to the live app, verbatim — the request options
    // (query, headers, body) flow in and the full response, `Set-Cookie` and
    // all, flows back. That round trip is what carries the same-origin session.
    if (site.render === "dynamic") return handle(method, path, options);

    return serveStatic(site, method, path, readStatic);
  };
}
