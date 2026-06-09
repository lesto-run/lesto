/**
 * @keel/content-seo - SEO Analysis and Schema.org Generation
 *
 * A browser-safe package for SEO analysis, keyword density tracking,
 * and Schema.org JSON-LD generation.
 *
 * @example
 * ```ts
 * import {
 *   analyzeSEO,
 *   lintSEO,
 *   jsonLd,
 *   generateSchemaOrg,
 *   analyzeKeywordDensity,
 * } from "@keel/content-seo";
 *
 * // Analyze content for SEO
 * const { metrics, recommendations } = lintSEO(markdownContent);
 * console.log(`SEO Score: ${metrics.score}/100`);
 *
 * // Generate JSON-LD for a blog post
 * const schema = jsonLd.blogPost(entry, {
 *   siteUrl: 'https://example.com',
 *   author: { name: 'Jane Doe' },
 * });
 *
 * // Analyze keyword density
 * const density = analyzeKeywordDensity(content, ['react', 'typescript']);
 * ```
 */

// SEO Analysis
export {
  analyzeSEO,
  generateSEORecommendations,
  lintSEO,
  getSEOScoreColor,
  getSEOScoreLabel,
  analyzeKeywordDensity,
  getKeywordDensityRating,
  getKeywordDensityColor,
} from "./analysis.js";

// Schema.org generation
export {
  generateSchemaOrg,
  generateFAQSchema,
  generateHowToSchema,
  generateBreadcrumbSchema,
  serializeSchemaOrg,
  mergeSchemaOrg,
} from "./schema-org.js";

// JSON-LD API
export { jsonLd } from "./json-ld.js";

// Types
export type {
  // Entry types
  EntryMeta,
  SchemaEntry,
  // SEO analysis types
  SEOMetrics,
  SEORecommendation,
  SEOResult,
  // Keyword density types
  KeywordMatch,
  KeywordDensityResult,
  KeywordDensityOptions,
  // Schema.org types
  EntrySchemaType,
  SchemaOrgType,
  SchemaOrgAuthor,
  SchemaOrgPublisher,
  SchemaOrgOptions,
  FAQItem,
  HowToStep,
  BreadcrumbItem,
} from "./types.js";
