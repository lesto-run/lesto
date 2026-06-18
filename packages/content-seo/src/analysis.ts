/**
 * SEO Analysis Module
 *
 * Analyzes markdown content for SEO metrics and generates recommendations.
 * Browser-safe - no Node.js dependencies.
 */

import { sanitizeObject } from "@lesto/content-shared/sanitize";
import type {
  SEOMetrics,
  SEORecommendation,
  SEOResult,
  KeywordMatch,
  KeywordDensityResult,
  KeywordDensityOptions,
} from "./types.js";

// --- Content Extraction ---

interface Heading {
  level: number;
  text: string;
}

interface Image {
  alt: string;
  src: string;
}

interface Link {
  text: string;
  url: string;
  isExternal: boolean;
}

/**
 * ContentExtractor - extracts structured data from markdown.
 */
class ContentExtractor {
  constructor(private content: string) {}

  headings(): Heading[] {
    // The full match (`#### Heading`) is always defined; we derive the level
    // from the leading run of '#' and the text from the remainder, which keeps
    // every read total and avoids an unreachable optional-group guard.
    const result: Heading[] = [];
    for (const m of this.content.matchAll(/^#{1,6}\s+.+$/gm)) {
      const line = m[0];
      const level = line.length - line.replace(/^#+/, "").length;
      result.push({ level, text: line.slice(level).trim() });
    }
    return result;
  }

  images(): Image[] {
    // Derive alt/src from the full match (`![alt](src)`) rather than optional
    // capture groups, so there is no unreachable undefined-guard to cover.
    const result: Image[] = [];
    for (const m of this.content.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
      const [alt, src] = splitBracketLink(m[0].slice(1));
      result.push({ alt, src });
    }
    return result;
  }

  links(): Link[] {
    // Match markdown links but not images (negative lookbehind for !).
    const result: Link[] = [];
    for (const m of this.content.matchAll(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g)) {
      const [text, url] = splitBracketLink(m[0]);
      result.push({
        text,
        url,
        isExternal: url.startsWith("http://") || url.startsWith("https://"),
      });
    }
    return result;
  }
}

/**
 * Split a `[text](url)` token into its two parts.
 * The caller only passes strings the link/image regexes already matched, so the
 * delimiters are guaranteed present — no defensive branching required here.
 */
function splitBracketLink(token: string): [string, string] {
  const split = token.indexOf("](");
  const text = token.slice(1, split);
  const url = token.slice(split + 2, -1);
  return [text, url];
}

/**
 * SEORecommendationFactory - creates recommendations with consistent structure.
 */
class SEORecommendationFactory {
  private idCounter = 0;

  private rec(
    type: SEORecommendation["type"],
    message: string,
    details?: string,
    fix?: string,
  ): SEORecommendation {
    return {
      id: `seo-rec-${++this.idCounter}`,
      type,
      message,
      ...(details && { details }),
      ...(fix && { fix }),
    };
  }

  error(message: string, details?: string, fix?: string) {
    return this.rec("error", message, details, fix);
  }
  warning(message: string, details?: string, fix?: string) {
    return this.rec("warning", message, details, fix);
  }
  success(message: string, details?: string) {
    return this.rec("success", message, details);
  }
  info(message: string, details?: string) {
    return this.rec("info", message, details);
  }
}

// --- Frontmatter Parsing ---

/**
 * Extract frontmatter from markdown content.
 * Uses sanitizeObject to prevent prototype pollution attacks.
 */
function extractFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match || match[1] === undefined) return {};

  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const rawValue = line.slice(colonIndex + 1).trim();
      // Remove quotes if present
      const value =
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
          ? rawValue.slice(1, -1)
          : rawValue;
      frontmatter[key] = value;
    }
  }
  // Sanitize to prevent prototype pollution
  return sanitizeObject(frontmatter);
}

/**
 * OG image field names in priority order.
 * First match wins.
 */
const OG_IMAGE_FIELDS = [
  "og_image",
  "ogImage",
  "og:image",
  "featuredImage",
  "featured_image",
  "cover",
  "coverImage",
  "cover_image",
  "image",
  "thumbnail",
] as const;

/**
 * Canonical URL field names in priority order.
 */
const CANONICAL_FIELDS = ["canonical", "canonicalUrl", "canonical_url"] as const;

interface FrontmatterMetadata {
  hasOgImage: boolean;
  ogImageField?: string;
  ogImageValue?: string;
  hasCanonicalUrl: boolean;
  canonicalUrl?: string;
}

/**
 * Find the first matching field value from a list of field names.
 */
function findFirstField<T extends readonly string[]>(
  frontmatter: Record<string, unknown>,
  fields: T,
): { field: T[number]; value: string } | undefined {
  for (const field of fields) {
    const value = frontmatter[field];
    if (typeof value === "string" && value.trim()) {
      return { field, value: value.trim() };
    }
  }
  return undefined;
}

/**
 * Extract SEO-relevant metadata from frontmatter.
 */
function extractFrontmatterMetadata(frontmatter: Record<string, unknown>): FrontmatterMetadata {
  const ogImage = findFirstField(frontmatter, OG_IMAGE_FIELDS);
  const canonical = findFirstField(frontmatter, CANONICAL_FIELDS);

  return {
    hasOgImage: ogImage !== undefined,
    ...(ogImage === undefined ? {} : { ogImageField: ogImage.field, ogImageValue: ogImage.value }),
    hasCanonicalUrl: canonical !== undefined,
    ...(canonical === undefined ? {} : { canonicalUrl: canonical.value }),
  };
}

/**
 * Strip frontmatter from content.
 */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/**
 * Strip markdown formatting from content, leaving plain text.
 * Removes code blocks, inline code, images, links (keeping text), formatting, headers, and HTML.
 */
function stripMarkdown(content: string): string {
  return (
    stripFrontmatter(content)
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, "")
      // Remove inline code
      .replace(/`[^`]+`/g, "")
      // Remove images
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
      // Remove links but keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove formatting
      .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
      // Remove headers
      .replace(/^#{1,6}\s+/gm, "")
      // Remove HTML
      .replace(/<[^>]+>/g, "")
  );
}

// --- Word/Paragraph Counting ---

/**
 * Count words in text, stripping markdown.
 */
function countWords(content: string): number {
  const plainText = stripMarkdown(content);
  const words = plainText.match(/\b\w+\b/g);
  return words ? words.length : 0;
}

/**
 * Count paragraphs in content.
 */
function countParagraphs(content: string): number {
  const plainContent = stripFrontmatter(content);
  const paragraphs = plainContent.split(/\n\n+/).filter((s) => s.trim() && !s.startsWith("#"));
  return paragraphs.length;
}

// --- Score Calculation ---

const SEO_WEIGHTS = {
  title: 20,
  metaDescription: 15,
  headings: 20,
  contentImages: 10, // Images in markdown body
  ogImage: 5, // Frontmatter OG/social image
  content: 20,
  links: 10,
};

function calculateTitleScore(title: SEOMetrics["title"]): number {
  // An empty title has length 0; once we know the title is non-empty its length
  // is necessarily > 0, so the trailing bands need no further length guard.
  if (!title.value) return 0;
  if (title.isOptimal) return SEO_WEIGHTS.title;
  if (title.length <= 70) return SEO_WEIGHTS.title * 0.7;
  return SEO_WEIGHTS.title * 0.3;
}

function calculateMetaScore(meta: SEOMetrics["metaDescription"]): number {
  // Same invariant as the title: a non-empty value always has length > 0.
  if (!meta.value) return 0;
  if (meta.isOptimal) return SEO_WEIGHTS.metaDescription;
  if (meta.length <= 200) return SEO_WEIGHTS.metaDescription * 0.7;
  return SEO_WEIGHTS.metaDescription * 0.3;
}

function calculateHeadingsScore(headings: SEOMetrics["headings"]): number {
  const hasH1Score = headings.hasH1 ? SEO_WEIGHTS.headings * 0.5 : 0;
  const hasH2Score = headings.h2Count > 0 ? SEO_WEIGHTS.headings * 0.3 : 0;
  const singleH1Score = headings.h1Count === 1 ? SEO_WEIGHTS.headings * 0.2 : 0;
  return hasH1Score + hasH2Score + singleH1Score;
}

function calculateContentImagesScore(images: SEOMetrics["images"]): number {
  if (images.total > 0) return SEO_WEIGHTS.contentImages * images.coverage;
  return SEO_WEIGHTS.contentImages * 0.5; // No images is okay for some content
}

function calculateOgImageScore(frontmatter: SEOMetrics["frontmatter"]): number {
  return frontmatter.hasOgImage ? SEO_WEIGHTS.ogImage : 0;
}

function calculateContentScore(content: SEOMetrics["content"]): number {
  if (content.hasEnoughContent) return SEO_WEIGHTS.content;
  if (content.wordCount >= 150) return SEO_WEIGHTS.content * 0.5;
  if (content.wordCount > 0) return SEO_WEIGHTS.content * 0.2;
  return 0;
}

function calculateLinksScore(links: SEOMetrics["links"]): number {
  // Every link is classified as exactly one of internal or external, so a
  // non-zero total guarantees at least one of the two counts is positive.
  if (links.total === 0) return SEO_WEIGHTS.links * 0.3;
  const hasBoth = links.internal > 0 && links.external > 0;
  return hasBoth ? SEO_WEIGHTS.links : SEO_WEIGHTS.links * 0.6;
}

function calculateScore(metrics: Omit<SEOMetrics, "score">): number {
  const score =
    calculateTitleScore(metrics.title) +
    calculateMetaScore(metrics.metaDescription) +
    calculateHeadingsScore(metrics.headings) +
    calculateContentImagesScore(metrics.images) +
    calculateOgImageScore(metrics.frontmatter) +
    calculateContentScore(metrics.content) +
    calculateLinksScore(metrics.links);

  return Math.round(Math.min(100, Math.max(0, score)));
}

// --- Recommendations ---

function getTitleRecommendations(
  title: SEOMetrics["title"],
  f: SEORecommendationFactory,
): SEORecommendation[] {
  if (!title.value) {
    return [
      f.error(
        "Missing title",
        "Add a title to your frontmatter for better SEO.",
        'Add `title: "Your Title"` to your frontmatter.',
      ),
    ];
  }
  if (title.length < 50) {
    return [
      f.warning(
        "Title is too short",
        `Your title is ${title.length} characters. Aim for 50-60 characters.`,
        "Expand your title to be more descriptive.",
      ),
    ];
  }
  if (title.length > 60) {
    return [
      f.warning(
        "Title is too long",
        `Your title is ${title.length} characters. Keep it under 60 for best display.`,
        "Shorten your title to prevent truncation in search results.",
      ),
    ];
  }
  return [
    f.success(
      "Title length is optimal",
      `${title.length} characters is within the ideal 50-60 range.`,
    ),
  ];
}

function getMetaRecommendations(
  meta: SEOMetrics["metaDescription"],
  f: SEORecommendationFactory,
): SEORecommendation[] {
  if (!meta.value) {
    return [
      f.error(
        "Missing meta description",
        "Add a description to your frontmatter for search result snippets.",
        'Add `description: "Your description"` to your frontmatter.',
      ),
    ];
  }
  if (meta.length < 150) {
    return [
      f.warning(
        "Meta description is too short",
        `Your description is ${meta.length} characters. Aim for 150-160.`,
        "Expand your description to better summarize the content.",
      ),
    ];
  }
  if (meta.length > 160) {
    return [
      f.warning(
        "Meta description is too long",
        `Your description is ${meta.length} characters. Keep it under 160.`,
        "Shorten your description to prevent truncation.",
      ),
    ];
  }
  return [
    f.success(
      "Meta description length is optimal",
      `${meta.length} characters is within the ideal 150-160 range.`,
    ),
  ];
}

function getHeadingRecommendations(
  headings: SEOMetrics["headings"],
  wordCount: number,
  f: SEORecommendationFactory,
): SEORecommendation[] {
  const recs: SEORecommendation[] = [];
  if (!headings.hasH1) {
    recs.push(
      f.warning(
        "Missing H1 heading",
        "Consider adding an H1 heading to your content.",
        "Add a main heading using # at the start of a line.",
      ),
    );
  } else if (headings.h1Count > 1) {
    recs.push(
      f.warning(
        "Multiple H1 headings",
        `Found ${headings.h1Count} H1 headings. Use only one per page.`,
        "Change extra H1s to H2 or lower.",
      ),
    );
  } else {
    recs.push(f.success("H1 heading is properly used"));
  }
  if (headings.h2Count === 0 && wordCount > 150) {
    recs.push(
      f.info(
        "Consider adding subheadings",
        "Break up longer content with H2 and H3 headings for better readability.",
      ),
    );
  }
  return recs;
}

function getImageRecommendations(
  images: SEOMetrics["images"],
  f: SEORecommendationFactory,
): SEORecommendation[] {
  if (images.missingAlt > 0) {
    return [
      f.warning(
        `${images.missingAlt} image(s) missing alt text`,
        "Alt text helps with accessibility and SEO.",
        "Add descriptive alt text to all images: ![alt text](image.jpg)",
      ),
    ];
  }
  if (images.total > 0) {
    return [f.success("All images have alt text")];
  }
  return [];
}

function getContentRecommendations(
  content: SEOMetrics["content"],
  f: SEORecommendationFactory,
): SEORecommendation[] {
  if (content.wordCount < 300) {
    return [
      f.warning(
        "Content may be too short",
        `${content.wordCount} words. Search engines prefer at least 300 words.`,
        "Consider expanding your content with more detail.",
      ),
    ];
  }
  return [f.success("Content length is good", `${content.wordCount} words is sufficient for SEO.`)];
}

function getLinkRecommendations(
  links: SEOMetrics["links"],
  wordCount: number,
  f: SEORecommendationFactory,
): SEORecommendation[] {
  const recs: SEORecommendation[] = [];
  if (links.internal === 0 && wordCount > 150) {
    recs.push(
      f.info(
        "Consider adding internal links",
        "Linking to other content helps with navigation and SEO.",
      ),
    );
  }
  if (links.external === 0 && wordCount > 300) {
    recs.push(
      f.info(
        "Consider adding external links",
        "Citing sources with external links can improve credibility.",
      ),
    );
  }
  return recs;
}

function getFrontmatterRecommendations(
  frontmatter: SEOMetrics["frontmatter"],
  f: SEORecommendationFactory,
): SEORecommendation[] {
  const recs: SEORecommendation[] = [];

  if (!frontmatter.hasOgImage) {
    recs.push(
      f.warning(
        "Missing Open Graph image",
        "Social shares will use a generic preview without a featured image.",
        'Add `og_image: "/images/my-post-og.png"` to your frontmatter.',
      ),
    );
  } else {
    recs.push(
      f.success(
        "Open Graph image configured",
        `Using ${frontmatter.ogImageField}: "${frontmatter.ogImageValue}"`,
      ),
    );
  }

  return recs;
}

// --- Public API ---

/**
 * Analyze markdown content for SEO metrics.
 *
 * @param content - The markdown content to analyze
 * @returns SEO metrics including score
 */
export function analyzeSEO(content: string): SEOMetrics {
  const frontmatter = extractFrontmatter(content);
  const extractor = new ContentExtractor(stripFrontmatter(content));

  // Title analysis
  const title = (frontmatter.title as string) || "";
  const isTitleOptimal = title.length >= 50 && title.length <= 60;

  // Meta description analysis
  const metaDescription =
    (frontmatter.description as string) ||
    (frontmatter.excerpt as string) ||
    (frontmatter.summary as string) ||
    "";
  const isMetaDescriptionOptimal = metaDescription.length >= 150 && metaDescription.length <= 160;

  // Headings analysis
  const headings = extractor.headings();
  const h1Count = headings.filter((h) => h.level === 1).length;
  const h2Count = headings.filter((h) => h.level === 2).length;
  const h3Count = headings.filter((h) => h.level === 3).length;

  // Images analysis
  const images = extractor.images();
  const imagesWithAlt = images.filter((img) => img.alt.trim().length > 0);

  // Links analysis
  const links = extractor.links();
  const internalLinks = links.filter((l) => !l.isExternal);
  const externalLinks = links.filter((l) => l.isExternal);

  // Content analysis
  const wordCount = countWords(content);
  const paragraphCount = countParagraphs(content);
  const imageCoverage = images.length > 0 ? imagesWithAlt.length / images.length : 1;

  // Frontmatter metadata extraction
  const frontmatterMeta = extractFrontmatterMetadata(frontmatter);

  const metricsWithoutScore: Omit<SEOMetrics, "score"> = {
    title: { value: title, length: title.length, isOptimal: isTitleOptimal },
    metaDescription: {
      value: metaDescription,
      length: metaDescription.length,
      isOptimal: isMetaDescriptionOptimal,
    },
    headings: {
      h1Count,
      h2Count,
      h3Count,
      hasH1: h1Count > 0,
      structure: headings.map((h) => `H${h.level}`),
    },
    images: {
      total: images.length,
      withAlt: imagesWithAlt.length,
      missingAlt: images.length - imagesWithAlt.length,
      coverage: imageCoverage,
    },
    links: { internal: internalLinks.length, external: externalLinks.length, total: links.length },
    content: { wordCount, paragraphCount, hasEnoughContent: wordCount >= 300 },
    frontmatter: frontmatterMeta,
  };

  return { ...metricsWithoutScore, score: calculateScore(metricsWithoutScore) };
}

/**
 * Generate SEO recommendations based on metrics.
 *
 * @param metrics - The SEO metrics to generate recommendations for
 * @returns Array of recommendations
 */
export function generateSEORecommendations(metrics: SEOMetrics): SEORecommendation[] {
  const f = new SEORecommendationFactory();
  const wordCount = metrics.content.wordCount;
  return [
    ...getTitleRecommendations(metrics.title, f),
    ...getMetaRecommendations(metrics.metaDescription, f),
    ...getHeadingRecommendations(metrics.headings, wordCount, f),
    ...getImageRecommendations(metrics.images, f),
    ...getFrontmatterRecommendations(metrics.frontmatter, f),
    ...getContentRecommendations(metrics.content, f),
    ...getLinkRecommendations(metrics.links, wordCount, f),
  ];
}

/**
 * Analyze content and generate recommendations in one call.
 *
 * @param content - The markdown content to analyze
 * @returns Complete SEO result with metrics and recommendations
 */
export function lintSEO(content: string): SEOResult {
  const metrics = analyzeSEO(content);
  const recommendations = generateSEORecommendations(metrics);
  return { metrics, recommendations };
}

/**
 * Get score color class based on value.
 */
export function getSEOScoreColor(score: number): string {
  if (score >= 80) return "text-green-500";
  if (score >= 60) return "text-yellow-500";
  if (score >= 40) return "text-orange-500";
  return "text-red-500";
}

/**
 * Get score label based on value.
 */
export function getSEOScoreLabel(score: number): string {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Needs Work";
  return "Poor";
}

// --- Keyword Density Analysis ---

/**
 * Analyze keyword density in content.
 *
 * Calculates how frequently focus keywords appear in content as a percentage
 * of total words. Ideal density is 1-3% for primary keywords.
 *
 * @param content - The markdown content to analyze
 * @param keywords - Array of focus keywords to track
 * @param options - Configuration options
 * @returns Keyword density analysis with locations and recommendations
 *
 * @example
 * ```typescript
 * const result = analyzeKeywordDensity(content, ['react', 'typescript']);
 * console.log(result.keywords[0].density); // e.g., 2.5 (percent)
 * ```
 */
export function analyzeKeywordDensity(
  content: string,
  keywords: string[],
  options: KeywordDensityOptions = {},
): KeywordDensityResult {
  const { contextLength = 50, maxLocations = 3, caseInsensitive = true } = options;

  // Strip frontmatter and markdown formatting
  const plainContent = stripMarkdown(content);

  const words = plainContent.match(/\b\w+\b/g) || [];
  const totalWords = words.length;

  if (totalWords === 0) {
    return {
      totalWords: 0,
      keywords: [],
      recommendations: [],
    };
  }

  const f = new SEORecommendationFactory();
  const recommendations: SEORecommendation[] = [];
  const keywordResults: KeywordMatch[] = [];

  for (const keyword of keywords) {
    // Create regex for keyword matching
    const flags = caseInsensitive ? "gi" : "g";
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escapedKeyword}\\b`, flags);

    // Find all matches with positions
    const matches: Array<{ index: number; match: string }> = [];
    for (const m of plainContent.matchAll(pattern)) {
      matches.push({ index: m.index, match: m[0] });
    }

    const count = matches.length;

    // Calculate density as percentage. We returned early above when totalWords
    // is 0, so the division here is always safe.
    // Count words that match the keyword (could be multi-word keywords).
    const keywordWordCount = keyword.split(/\s+/).length;
    const density = ((count * keywordWordCount) / totalWords) * 100;

    // Extract location samples
    const locations = matches.slice(0, maxLocations).map((m) => {
      const start = Math.max(0, m.index - contextLength);
      const end = Math.min(plainContent.length, m.index + m.match.length + contextLength);
      const baseContext = plainContent.slice(start, end).trim();
      // Add ellipsis if truncated - immutable pattern per AGENTS.md
      const context =
        (start > 0 ? "..." : "") + baseContext + (end < plainContent.length ? "..." : "");

      return {
        context,
        position: m.index,
      };
    });

    keywordResults.push({
      keyword,
      count,
      density: Math.round(density * 100) / 100, // Round to 2 decimal places
      locations,
    });

    // Generate recommendations based on density
    if (count === 0) {
      recommendations.push(
        f.warning(
          `Keyword "${keyword}" not found`,
          "Consider adding this keyword to your content for better targeting.",
          `Include "${keyword}" naturally in your content.`,
        ),
      );
    } else if (density < 0.5) {
      recommendations.push(
        f.info(
          `Low density for "${keyword}"`,
          `Appears ${count} time(s) (${density.toFixed(1)}%). Consider adding more mentions to reach 1-3% density.`,
        ),
      );
    } else if (density > 3) {
      recommendations.push(
        f.warning(
          `High density for "${keyword}"`,
          `Appears ${count} time(s) (${density.toFixed(1)}%). May appear as keyword stuffing.`,
          `Reduce usage of "${keyword}" to maintain natural readability.`,
        ),
      );
    } else {
      recommendations.push(
        f.success(
          `Good density for "${keyword}"`,
          `Appears ${count} time(s) (${density.toFixed(1)}%). Optimal range is 1-3%.`,
        ),
      );
    }
  }

  return {
    totalWords,
    keywords: keywordResults,
    recommendations,
  };
}

/**
 * Get keyword density rating based on percentage.
 */
export function getKeywordDensityRating(density: number): "low" | "optimal" | "high" {
  if (density < 0.5) return "low";
  if (density > 3) return "high";
  return "optimal";
}

const KEYWORD_DENSITY_COLORS: Record<"low" | "optimal" | "high", string> = {
  optimal: "text-green-500",
  low: "text-yellow-500",
  high: "text-red-500",
};

/**
 * Get color class for keyword density.
 */
export function getKeywordDensityColor(density: number): string {
  return KEYWORD_DENSITY_COLORS[getKeywordDensityRating(density)];
}
