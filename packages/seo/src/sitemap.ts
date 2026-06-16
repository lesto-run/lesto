import { escape } from "./escape";
import { assertNoInjection } from "./guard";

/** One entry in a sitemap. `loc` may be relative if a `baseUrl` is supplied. */
export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  priority?: number;
}

/** Knobs for the whole document. */
export interface SitemapOptions {
  baseUrl?: string;
}

/**
 * Render a sitemap XML document.
 *
 * A relative `loc` is resolved against `baseUrl` when one is given; an absolute
 * `loc` (it has a scheme) is left untouched. Absent `lastmod`/`priority` emit
 * no child element. Every value is XML-escaped, and the resolved URL is refused
 * with a coded `SeoError` if it carries a `\r`/`\n` or a `#` fragment.
 */
export function sitemap(urls: SitemapUrl[], options: SitemapOptions = {}): string {
  const { baseUrl } = options;

  const entries = urls.map((url) => renderUrl(url, baseUrl)).join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    entries,
    `</urlset>`,
  ].join("\n");
}

function renderUrl(url: SitemapUrl, baseUrl: string | undefined): string {
  const loc = resolve(url.loc, baseUrl);

  assertNoInjection("Sitemap loc", loc);

  const children: string[] = [`  <loc>${escape(loc)}</loc>`];

  if (url.lastmod !== undefined) {
    children.push(`  <lastmod>${escape(url.lastmod)}</lastmod>`);
  }

  if (url.priority !== undefined) {
    children.push(`  <priority>${url.priority}</priority>`);
  }

  return [`<url>`, ...children, `</url>`].join("\n");
}

/** Prefix a relative loc with the base URL; leave an absolute loc as-is. */
function resolve(loc: string, baseUrl: string | undefined): string {
  if (baseUrl === undefined) return loc;

  if (isAbsolute(loc)) return loc;

  // Join on exactly one slash regardless of how either side is punctuated.
  const left = baseUrl.replace(/\/+$/, "");
  const right = loc.replace(/^\/+/, "");

  return `${left}/${right}`;
}

/** A loc is absolute when it carries a URL scheme like `https:`. */
function isAbsolute(loc: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(loc);
}
