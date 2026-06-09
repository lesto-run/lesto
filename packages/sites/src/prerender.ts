import type { PageHandler, RenderedPage, StaticSite } from "./types";

/** Drop leading and trailing slashes: `"/a/b/"` -> `"a/b"`. */
function trimSlashes(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Join a site's `basePath` with one of its routes into the path the app sees.
 *
 *   ("/", "/")            -> "/"
 *   ("/", "/about")       -> "/about"
 *   ("/mls", "/")         -> "/mls"
 *   ("/mls", "/listings") -> "/mls/listings"
 */
function joinPath(basePath: string, route: string): string {
  const base = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  const rest = route === "/" ? "" : `/${trimSlashes(route)}`;
  const joined = `${base}${rest}`;

  return joined === "" ? "/" : joined;
}

/**
 * The file a route prerenders to.
 *
 * A page becomes a clean-URL directory + `index.html`; a route that already
 * names a file (its last segment has an extension, e.g. `sitemap.xml`) is
 * written verbatim — the same split every static generator makes between pages
 * and endpoints.
 *
 *   ("site", "/")            -> "site/index.html"
 *   ("site", "/about")       -> "site/about/index.html"
 *   ("site", "/sitemap.xml") -> "site/sitemap.xml"
 */
function toOutputPath(siteName: string, route: string): string {
  const clean = trimSlashes(route);

  if (clean === "") return `${siteName}/index.html`;

  const lastSegment = clean.slice(clean.lastIndexOf("/") + 1);
  const isFile = lastSegment.includes(".");

  return isFile ? `${siteName}/${clean}` : `${siteName}/${clean}/index.html`;
}

/** Resolve a static site's pages, whether they were a list or a function. */
async function resolvePages(site: StaticSite): Promise<readonly string[]> {
  return typeof site.pages === "function" ? site.pages() : site.pages;
}

/**
 * Prerender a static site by asking the app to render each page.
 *
 * This is the keystone: a static site is the dynamic app, rendered offline. For
 * each route we call the app's own `handle("GET", path)` — the exact code path a
 * live request takes — and capture the HTML and its status, so the build can
 * fail on a page the app could not render.
 */
export async function prerenderSite(
  site: StaticSite,
  handle: PageHandler,
): Promise<RenderedPage[]> {
  const routes = await resolvePages(site);

  const pages: RenderedPage[] = [];

  for (const route of routes) {
    const path = joinPath(site.basePath, route);
    const response = await handle("GET", path);

    pages.push({
      path,
      outputPath: toOutputPath(site.name, route),
      status: response.status,
      html: response.body,
    });
  }

  return pages;
}
