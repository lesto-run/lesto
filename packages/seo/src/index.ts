/**
 * @volo/seo — SEO primitives as pure string builders, no dependencies.
 *
 *   metaTags({ title: "Home", description: "Welcome" });
 *   sitemap([{ loc: "/about" }], { baseUrl: "https://example.com" });
 *   robots({ disallow: ["/admin"], sitemap: "https://example.com/sitemap.xml" });
 *   jsonLd("Article", { headline: "Hello" });
 */

export { metaTags } from "./meta-tags";
export type { MetaTagsInput } from "./meta-tags";

export { sitemap } from "./sitemap";
export type { SitemapOptions, SitemapUrl } from "./sitemap";

export { robots } from "./robots";
export type { RobotsInput } from "./robots";

export { jsonLd } from "./json-ld";

export { escape } from "./escape";

export { VoloError, SeoError } from "./errors";
export type { SeoErrorCode } from "./errors";
