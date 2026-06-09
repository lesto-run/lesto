/**
 * The path math shared by building and serving a site.
 *
 * Building writes a route to a file; serving maps a request back to that same
 * file. They must agree, so the mapping lives here once and both import it.
 */

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
export function sitePath(basePath: string, route: string): string {
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
export function outputPath(siteName: string, route: string): string {
  const clean = trimSlashes(route);

  if (clean === "") return `${siteName}/index.html`;

  const lastSegment = clean.slice(clean.lastIndexOf("/") + 1);
  const isFile = lastSegment.includes(".");

  return isFile ? `${siteName}/${clean}` : `${siteName}/${clean}/index.html`;
}
