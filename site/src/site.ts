/**
 * Site-wide constants, in a leaf module so any layer can import them without a
 * cycle (the app factory, the build, the doc-page UI, the AI-docs surface all
 * reach for the canonical origin).
 */

/** The canonical origin the docs site is served from — drives canonical + OG URLs. */
export const SITE_URL = "https://docs.lesto.run";

/** Absolute, canonical URL for a route (`/` keeps its single trailing segment). */
export function canonicalUrl(route: string): string {
  return route === "/" ? `${SITE_URL}/` : `${SITE_URL}${route}`;
}
