/**
 * A fully prerendered site's discoverability surface — sitemap, robots, and the
 * social-preview / favicon assets every static marketing or docs site also ships.
 *
 * The build prerenders the HTML ({@link buildStaticSites}); this owns the files
 * that go alongside it. `defineStaticSite` derives the sitemap from the route list
 * and returns an `emit(sink)` that writes `sitemap.xml`, `robots.txt`, and any
 * `og.svg` / `favicon.svg` through the same {@link OutputSink} seam the pages use —
 * so an app no longer hand-rolls the SEO emit in its build script.
 *
 * Substrate-agnostic by construction: it takes a sink, not a path, and depends
 * only on `@lesto/seo`'s pure string builders. The Cloudflare edge front door is
 * a separate concern (`@lesto/cloudflare`'s `staticAssetsWorker`).
 */

import { robots, sitemap, type SitemapUrl } from "@lesto/seo";

import type { OutputSink } from "./types";

/** The inputs that describe a static site's discoverability surface. */
export interface StaticSiteConfig {
  /** Absolute site origin for canonical URLs + the robots `Sitemap:` line (e.g. `https://lesto.run`). A trailing slash is ignored. */
  readonly siteUrl: string;
  /** The routes to advertise in the sitemap — absolute paths like `/` or `/blog`. */
  readonly routes: readonly string[];
  /** Per-route sitemap priority. Defaults to 1 for the home route (`/`), else 0.7. */
  readonly priority?: (route: string) => number;
  /** The Open Graph card as an SVG string (e.g. from `@lesto/seo`'s `ogImage`). Emitted to `og.svg` when present. */
  readonly og?: string;
  /** A favicon as an SVG string. Emitted to `favicon.svg` when present. */
  readonly favicon?: string;
}

/** A declared static site: its derived sitemap, and a sink-driven emitter for its files. */
export interface StaticSiteArtifacts {
  /** The sitemap URLs derived from {@link StaticSiteConfig.routes}, exposed for callers that want them. */
  readonly sitemapUrls: readonly SitemapUrl[];
  /** Emit `sitemap.xml`, `robots.txt`, and any `og.svg` / `favicon.svg` through the sink. */
  emit(sink: OutputSink): Promise<void>;
}

/** Drop any trailing slashes so `${siteUrl}${route}` never doubles up. */
function origin(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, "");
}

/**
 * Declare a fully prerendered site's discoverability surface.
 *
 *   const site = defineStaticSite({ siteUrl, routes, og: ogImage(), favicon });
 *   await site.emit(nodeSink("out/www"));
 */
export function defineStaticSite(config: StaticSiteConfig): StaticSiteArtifacts {
  const base = origin(config.siteUrl);
  const priority = config.priority ?? ((route: string): number => (route === "/" ? 1 : 0.7));
  const canonical = (route: string): string => (route === "/" ? `${base}/` : `${base}${route}`);

  const sitemapUrls: SitemapUrl[] = config.routes.map((route) => ({
    loc: canonical(route),
    priority: priority(route),
  }));

  return {
    sitemapUrls,
    async emit(sink: OutputSink): Promise<void> {
      await sink("sitemap.xml", sitemap(sitemapUrls));
      await sink("robots.txt", robots({ sitemap: `${base}/sitemap.xml` }));
      if (config.og !== undefined) {
        await sink("og.svg", config.og);
      }
      if (config.favicon !== undefined) {
        await sink("favicon.svg", config.favicon);
      }
    },
  };
}
