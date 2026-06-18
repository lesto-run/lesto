/**
 * @volo/sites — one project, many sites, one substrate.
 *
 * Declare a set of sites over the same app (`defineSites`), each mounted at a
 * path and rendered static or dynamic. Static sites are prerendered from the
 * app's own request handler (`prerenderSite`) and written through a pluggable
 * sink (`writePages` / `nodeSink`) — so a static site is just the dynamic app,
 * rendered offline and shipped to a CDN.
 *
 *   const sites = defineSites([
 *     { name: "marketing", render: "static", basePath: "/", pages: ["/", "/about"] },
 *     { name: "mls", render: "dynamic", basePath: "/mls" },
 *   ]);
 *
 *   const pages = await prerenderSite(sites[0], app.handle);
 *   await writePages(pages, nodeSink("out"));
 */

export { defineSites } from "./define";

export { sitePath, outputPath } from "./paths";

export { prerenderSite } from "./prerender";

export { writePages, nodeSink } from "./write";

export { buildStaticSites } from "./build";
export type { SiteManifest } from "./build";

export { SitesError } from "./errors";
export type { SitesErrorCode } from "./errors";

export type {
  Site,
  StaticSite,
  DynamicSite,
  SiteRender,
  PagesSource,
  PageHandler,
  RenderResponse,
  VoloResponseBody,
  RenderedPage,
  OutputSink,
} from "./types";
