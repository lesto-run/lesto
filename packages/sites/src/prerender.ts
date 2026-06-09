import { outputPath, sitePath } from "./paths";
import type { PageHandler, RenderedPage, StaticSite } from "./types";

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
    const path = sitePath(site.basePath, route);
    const response = await handle("GET", path);

    pages.push({
      path,
      outputPath: outputPath(site.name, route),
      status: response.status,
      html: response.body,
    });
  }

  return pages;
}
