/**
 * Site-wide constants, in a leaf module so any layer can import them without a
 * cycle (the app factory, the build, the page UI all reach for the canonical
 * origin).
 */

/** The canonical origin the marketing site is served from — drives canonical + OG URLs. */
export const SITE_URL = "https://lesto.run";

/** The docs site (a sibling Worker) — where reference docs, quickstart, and concepts live. */
export const DOCS_URL = "https://docs.lesto.run";

/** The GitHub repository — the source of truth for the framework. */
export const GITHUB_URL = "https://github.com/lesto-run/lesto";

/** Absolute, canonical URL for a route (`/` keeps its single trailing segment). */
export function canonicalUrl(route: string): string {
  return route === "/" ? `${SITE_URL}/` : `${SITE_URL}${route}`;
}
