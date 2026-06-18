/**
 * SEO Package Type Definitions
 *
 * Browser-safe types for SEO analysis and Schema.org generation.
 */

// --- Content Entry Types ---

/**
 * Minimal entry metadata required for schema generation.
 * Compatible with @volo/content-core RuntimeEntry but doesn't require the dependency.
 */
export interface EntryMeta {
  readonly id: string;
  readonly collection: string;
}

/**
 * Entry type for schema generation.
 * Accepts any object with the required metadata fields.
 */
export type SchemaEntry = Record<string, unknown> & EntryMeta;

// --- SEO Analysis Types ---

export interface SEOMetrics {
  score: number; // 0-100
  title: {
    value: string;
    length: number;
    isOptimal: boolean; // 50-60 chars
  };
  metaDescription: {
    value: string;
    length: number;
    isOptimal: boolean; // 150-160 chars
  };
  headings: {
    h1Count: number;
    h2Count: number;
    h3Count: number;
    hasH1: boolean;
    structure: string[]; // e.g., ["H1", "H2", "H3", "H2"]
  };
  images: {
    total: number;
    withAlt: number;
    missingAlt: number;
    coverage: number; // 0-1 percentage
  };
  links: {
    internal: number;
    external: number;
    total: number;
  };
  content: {
    wordCount: number;
    paragraphCount: number;
    hasEnoughContent: boolean; // > 300 words
  };
  frontmatter: {
    hasOgImage: boolean;
    ogImageField?: string; // 'og_image' | 'ogImage' | 'featuredImage' | etc.
    ogImageValue?: string; // The actual URL/path
    hasCanonicalUrl: boolean;
    canonicalUrl?: string;
  };
}

export interface SEORecommendation {
  id: string;
  type: "error" | "warning" | "success" | "info";
  message: string;
  details?: string;
  fix?: string;
}

export interface SEOResult {
  metrics: SEOMetrics;
  recommendations: SEORecommendation[];
}

// --- Keyword Density Types ---

export interface KeywordMatch {
  keyword: string;
  count: number;
  density: number; // percentage (0-100)
  locations: Array<{
    context: string; // surrounding text
    position: number; // character offset
  }>;
}

export interface KeywordDensityResult {
  totalWords: number;
  keywords: KeywordMatch[];
  recommendations: SEORecommendation[];
}

export interface KeywordDensityOptions {
  /** Maximum context characters to show around keyword matches. Default: 50 */
  contextLength?: number;
  /** Maximum number of location samples per keyword. Default: 3 */
  maxLocations?: number;
  /** Case-insensitive matching. Default: true */
  caseInsensitive?: boolean;
}

// --- Schema.org Types ---

/**
 * Schema types that can be generated from an entry.
 * Use generateSchemaOrg(entry, type, options) for these types.
 */
export type EntrySchemaType =
  | "Article"
  | "BlogPosting"
  | "TechArticle"
  | "NewsArticle"
  | "Product"
  | "WebPage";

/**
 * All Schema.org types supported by this module.
 * - Entry-based types: Use generateSchemaOrg(entry, type, options)
 * - FAQ: Use generateFAQSchema(items)
 * - HowTo: Use generateHowToSchema(name, steps)
 * - BreadcrumbList: Use generateBreadcrumbSchema(items)
 */
export type SchemaOrgType = EntrySchemaType | "FAQ" | "HowTo" | "BreadcrumbList";

export interface SchemaOrgAuthor {
  name: string;
  url?: string;
  image?: string;
}

export interface SchemaOrgPublisher {
  name: string;
  logo?: string;
  url?: string;
}

export interface SchemaOrgOptions {
  /** Base site URL for generating absolute URLs */
  siteUrl: string;
  /** Author information */
  author?: SchemaOrgAuthor;
  /** Publisher/organization information */
  publisher?: SchemaOrgPublisher;
  /** Field to use for date. Default: "date" or "publishedAt" */
  dateField?: string;
  /** Field to use for modified date. Default: "updatedAt" or "modifiedAt" */
  modifiedDateField?: string;
  /** Field to use for description. Default: "description" */
  descriptionField?: string;
  /** Field to use for image. Default: "image" or "og_image" */
  imageField?: string;
  /** Custom URL path generator */
  urlGenerator?: (entry: SchemaEntry) => string;
}

export interface FAQItem {
  question: string;
  answer: string;
}

export interface HowToStep {
  name: string;
  text: string;
  image?: string;
}

export interface BreadcrumbItem {
  name: string;
  url: string;
}
