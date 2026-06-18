/**
 * Local-dev serving: one origin, every zone rendered live.
 *
 * The insight that makes `volo dev` instant: in development a "static" zone
 * needs no prebuild. A static site is just the dynamic app rendered offline —
 * so in dev we render it *online*, byte-identical, straight through
 * `app.handle`. An edit shows on the next refresh with no build step, because
 * there is no build step. {@link dispatchSites} reads prebuilt files for
 * production; this dispatcher reads nothing and renders everything.
 *
 * Site selection is the production rule exactly — the same {@link selectSite}
 * longest-prefix, segment-boundary match — so dev and prod route a request to
 * the same owning zone. The only divergence is what happens after: prod splits
 * static (read a file) from dynamic (delegate); dev delegates *both*.
 *
 * One thing sits in front of selection: the client asset passthrough. The
 * island hydration bundle (`/client.js`) and its friends are build output, not
 * a page route, so a `readAsset` port — injected, like everything that varies —
 * gets first refusal on asset-shaped paths. A hit serves the asset with the
 * right content-type; a miss falls through to the sites, so a real `.js` *page*
 * route still works.
 */

import { contentTypeOf, selectSite } from "./sites";
import type { AppHandler, RequestOptions, StaticReader } from "./sites";

import type { Site } from "@volo/sites";

import type { VoloResponse } from "@volo/web";

/** Everything the dev dispatcher needs, injected so the core stays pure. */
export interface DispatchSitesDevDeps {
  /** The mounted sites, in any order — selection is by longest matching prefix. */
  readonly sites: readonly Site[];

  /** The live app's request handler. In dev, *every* zone delegates here. */
  readonly handle: AppHandler;

  /**
   * Reads a client build asset by request path, or `undefined` if absent.
   *
   * Optional: with no asset reader, every path goes to site dispatch. When
   * present, it is consulted first for asset-shaped paths — that is how the
   * island bundle reaches the browser before any page route can shadow it.
   */
  readonly readAsset?: StaticReader;
}

/** The extensions we treat as build assets — scripts, styles, and source maps. */
const ASSET_EXTENSIONS: readonly string[] = [".js", ".css", ".map"];

/** A bare-bones response with no body — for the 404. */
function notFound(): VoloResponse {
  return { status: 404, headers: {}, body: "" };
}

/**
 * True iff a path looks like a client build asset rather than a page route.
 *
 * Kept deliberately simple and visible: a fixed set of build-output extensions.
 * It is only a *first guess* — a miss from {@link DispatchSitesDevDeps.readAsset}
 * falls through to the sites, so misclassifying a real `.js` page route here
 * costs nothing; the page still renders.
 */
function looksLikeAsset(path: string): boolean {
  return ASSET_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/**
 * Serve a client build asset if the reader has it.
 *
 * Returns the asset response on a hit, or `undefined` on a miss so the caller
 * falls through to site dispatch. The content-type is the same {@link
 * contentTypeOf} table production labels its files with — never a second copy.
 */
async function serveAsset(
  path: string,
  readAsset: StaticReader,
): Promise<VoloResponse | undefined> {
  // The reader resolves paths *relative to its root* (the same contract
  // `outputPath` produces for production). A request path is rooted (`/client.js`),
  // and a leading slash reads as absolute — escaping the root — so strip it to a
  // relative key before handing it over.
  const file = path.replace(/^\/+/, "");

  const body = await readAsset(file);

  if (body === undefined) return undefined;

  return {
    status: 200,
    headers: { "content-type": contentTypeOf(file) },
    // Dev build assets are text (`.js`/`.css`/`.map` — see ASSET_EXTENSIONS), and
    // a reader may hand them back as bytes (nodeStaticReader reads from disk),
    // so decode to a UTF-8 string to match the Content-Type above. A string the
    // reader already produced passes straight through.
    body: typeof body === "string" ? body : Buffer.from(body).toString("utf8"),
  };
}

/**
 * Build the dev dispatcher over a set of sites.
 *
 * Returns a handler `(method, path, options?) -> response`. First, asset
 * passthrough: if a reader is injected and the path is asset-shaped, a hit
 * serves it and a miss falls through. Then site selection by the production
 * rule, and — the whole point — *any* matched zone, static or dynamic, renders
 * live via `handle`. No owning site is a 404.
 */
export function dispatchSitesDev(
  deps: DispatchSitesDevDeps,
): (method: string, path: string, options?: RequestOptions) => Promise<VoloResponse> {
  const { sites, handle, readAsset } = deps;

  return async (method, path, options) => {
    // Assets come before the sites: the island bundle is build output, not a
    // page any zone owns, so it must not have to win path selection to be served.
    if (readAsset !== undefined && looksLikeAsset(path)) {
      const asset = await serveAsset(path, readAsset);

      if (asset !== undefined) return asset;
    }

    const site = selectSite(sites, path);

    if (site === undefined) return notFound();

    // The dev difference in one line: static or dynamic, the zone renders live.
    // A static site is the dynamic app rendered offline — so render it online.
    return handle(method, path, options);
  };
}
