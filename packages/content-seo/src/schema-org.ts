/**
 * Schema.org / JSON-LD Generation Primitives
 *
 * Generates structured data for search engine optimization.
 * Framework-agnostic - users serialize and inject into their templates.
 */

import { serializeJsonLd } from "@keel/content-shared/sanitize";
import { validateUrl } from "@keel/content-shared/validation";
import type {
  SchemaEntry,
  EntrySchemaType,
  SchemaOrgAuthor,
  SchemaOrgPublisher,
  SchemaOrgOptions,
  FAQItem,
  HowToStep,
  BreadcrumbItem,
} from "./types.js";

// --- Helper Functions ---

function getFieldValue(entry: SchemaEntry, field: string): unknown {
  return (entry as Record<string, unknown>)[field];
}

function findField(entry: SchemaEntry, ...fields: string[]): string | undefined {
  for (const field of fields) {
    const value = getFieldValue(entry, field);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function formatDate(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    if (!isNaN(date.getTime())) return date.toISOString();
  }
  return undefined;
}

/**
 * Valid Schema.org availability values with normalized aliases.
 */
const AVAILABILITY_MAP = new Map<string, string>([
  ["instock", "https://schema.org/InStock"],
  ["in stock", "https://schema.org/InStock"],
  ["in_stock", "https://schema.org/InStock"],
  ["outofstock", "https://schema.org/OutOfStock"],
  ["out of stock", "https://schema.org/OutOfStock"],
  ["out_of_stock", "https://schema.org/OutOfStock"],
  ["preorder", "https://schema.org/PreOrder"],
  ["pre order", "https://schema.org/PreOrder"],
  ["pre_order", "https://schema.org/PreOrder"],
  ["backorder", "https://schema.org/BackOrder"],
  ["back order", "https://schema.org/BackOrder"],
  ["back_order", "https://schema.org/BackOrder"],
  ["discontinued", "https://schema.org/Discontinued"],
  ["soldout", "https://schema.org/SoldOut"],
  ["sold out", "https://schema.org/SoldOut"],
  ["sold_out", "https://schema.org/SoldOut"],
  ["limitedavailability", "https://schema.org/LimitedAvailability"],
  ["limited availability", "https://schema.org/LimitedAvailability"],
  ["limited_availability", "https://schema.org/LimitedAvailability"],
  ["onlineonly", "https://schema.org/OnlineOnly"],
  ["online only", "https://schema.org/OnlineOnly"],
  ["online_only", "https://schema.org/OnlineOnly"],
]);

/**
 * Normalize availability value to Schema.org URL.
 */
function normalizeAvailability(value: string | undefined): string {
  if (!value) return "https://schema.org/InStock";
  const normalized = value.toLowerCase().trim();
  return AVAILABILITY_MAP.get(normalized) ?? "https://schema.org/InStock";
}

function normalizeUrl(siteUrl: string): string {
  const url = validateUrl(siteUrl, "siteUrl");
  return url.origin + url.pathname.replace(/\/$/, "");
}

function generateEntryUrl(
  entry: SchemaEntry,
  siteUrl: string,
  urlGenerator?: (entry: SchemaEntry) => string
): string {
  if (urlGenerator) {
    const customUrl = urlGenerator(entry);
    // Validate custom URL
    validateUrl(customUrl, "urlGenerator result");
    return customUrl;
  }
  const baseUrl = normalizeUrl(siteUrl);
  const collection = encodeURIComponent(entry.collection || "");
  const slug = encodeURIComponent(String(entry["slug"] || entry.id || ""));

  if (!slug) {
    throw new Error("Entry must have a slug or id for URL generation");
  }

  return `${baseUrl}/${collection}/${slug}`;
}

function createAuthorSchema(author: SchemaOrgAuthor): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    "@type": "Person",
    name: author.name,
  };
  if (author.url) schema["url"] = author.url;
  if (author.image) schema["image"] = author.image;
  return schema;
}

function createPublisherSchema(publisher: SchemaOrgPublisher): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    "@type": "Organization",
    name: publisher.name,
  };
  if (publisher.url) schema["url"] = publisher.url;
  if (publisher.logo) {
    schema["logo"] = {
      "@type": "ImageObject",
      url: publisher.logo,
    };
  }
  return schema;
}

function createImageSchema(imageUrl: string): Record<string, unknown> {
  return {
    "@type": "ImageObject",
    url: imageUrl,
  };
}

// --- Article Types ---

function generateArticleSchema(
  entry: SchemaEntry,
  type: "Article" | "BlogPosting" | "TechArticle" | "NewsArticle",
  options: SchemaOrgOptions
): Record<string, unknown> {
  const {
    siteUrl,
    author,
    publisher,
    dateField = "date",
    modifiedDateField,
    descriptionField = "description",
    imageField,
    urlGenerator,
  } = options;

  const title = findField(entry, "title") || (entry["slug"] as string);
  const description = findField(entry, descriptionField, "excerpt", "summary");
  const url = generateEntryUrl(entry, siteUrl, urlGenerator);

  // Try multiple date fields
  const dateValue =
    getFieldValue(entry, dateField) ||
    getFieldValue(entry, "publishedAt") ||
    getFieldValue(entry, "createdAt");
  const datePublished = formatDate(dateValue);

  // Try multiple modified date fields
  const modifiedValue =
    getFieldValue(entry, modifiedDateField ?? "updatedAt") || getFieldValue(entry, "modifiedAt");
  const dateModified = formatDate(modifiedValue);

  // Try multiple image fields
  const image = findField(
    entry,
    imageField ?? "image",
    "og_image",
    "ogImage",
    "featuredImage",
    "cover"
  );

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": type,
    headline: title,
    url,
  };

  if (description) schema["description"] = description;
  if (datePublished) schema["datePublished"] = datePublished;
  if (dateModified) schema["dateModified"] = dateModified;
  if (image) schema["image"] = createImageSchema(image);
  if (author) schema["author"] = createAuthorSchema(author);
  if (publisher) schema["publisher"] = createPublisherSchema(publisher);

  // Add mainEntityOfPage for better SEO
  schema["mainEntityOfPage"] = {
    "@type": "WebPage",
    "@id": url,
  };

  return schema;
}

// --- Product ---

function generateProductSchema(
  entry: SchemaEntry,
  options: SchemaOrgOptions
): Record<string, unknown> {
  const { siteUrl, descriptionField = "description", imageField, urlGenerator } = options;

  const name = findField(entry, "name", "title") || (entry["slug"] as string);
  const description = findField(entry, descriptionField, "excerpt");
  const url = generateEntryUrl(entry, siteUrl, urlGenerator);
  const image = findField(entry, imageField ?? "image", "productImage", "og_image");

  // Get price info if available
  const price = getFieldValue(entry, "price");
  const currency = findField(entry, "currency") || "USD";
  const availability = findField(entry, "availability");
  const brand = findField(entry, "brand");
  const sku = findField(entry, "sku");

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name,
    url,
  };

  if (description) schema["description"] = description;
  if (image) schema["image"] = createImageSchema(image);
  if (brand) {
    schema["brand"] = {
      "@type": "Brand",
      name: brand,
    };
  }
  if (sku) schema["sku"] = sku;

  // Add offers if price is available
  if (price !== undefined && price !== null) {
    schema["offers"] = {
      "@type": "Offer",
      price: String(price),
      priceCurrency: currency,
      availability: normalizeAvailability(availability),
      url,
    };
  }

  return schema;
}

// --- FAQ ---

/**
 * Generate FAQ schema from a list of question/answer pairs.
 *
 * @param items - Array of FAQ items with question and answer
 * @returns Schema.org FAQPage object
 */
export function generateFAQSchema(items: FAQItem[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

// --- HowTo ---

/**
 * Generate HowTo schema from a list of steps.
 *
 * @param name - Name of the how-to guide
 * @param steps - Array of step objects
 * @param options - Optional description and image
 * @returns Schema.org HowTo object
 */
export function generateHowToSchema(
  name: string,
  steps: HowToStep[],
  options?: { description?: string; image?: string }
): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name,
    step: steps.map((step, index) => ({
      "@type": "HowToStep",
      position: index + 1,
      name: step.name,
      text: step.text,
      ...(step.image && { image: step.image }),
    })),
  };

  if (options?.description) schema["description"] = options.description;
  if (options?.image) schema["image"] = options.image;

  return schema;
}

// --- Breadcrumb ---

/**
 * Generate BreadcrumbList schema from navigation items.
 *
 * @param items - Array of breadcrumb items with name and URL
 * @returns Schema.org BreadcrumbList object
 */
export function generateBreadcrumbSchema(items: BreadcrumbItem[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

// --- WebPage ---

function generateWebPageSchema(
  entry: SchemaEntry,
  options: SchemaOrgOptions
): Record<string, unknown> {
  const { siteUrl, descriptionField = "description", urlGenerator } = options;

  const name = findField(entry, "title", "name") || (entry["slug"] as string);
  const description = findField(entry, descriptionField, "excerpt");
  const url = generateEntryUrl(entry, siteUrl, urlGenerator);

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name,
    url,
  };

  if (description) schema["description"] = description;

  return schema;
}

// --- Public API ---

/**
 * Generate Schema.org structured data from a content entry.
 *
 * For entry-based types (Article, BlogPosting, Product, WebPage, etc.),
 * data is automatically extracted from the entry's frontmatter fields.
 *
 * For specialized types that require explicit structured data, use:
 * - generateFAQSchema(items) for FAQ pages
 * - generateHowToSchema(name, steps) for how-to guides
 * - generateBreadcrumbSchema(items) for navigation breadcrumbs
 *
 * @param entry - The entry to generate schema for
 * @param type - The Schema.org type to generate (entry-based types only)
 * @param options - Configuration options
 * @returns Schema.org object ready for serialization
 *
 * @example
 * ```typescript
 * const post = getEntry('posts', 'hello-world');
 * const schema = generateSchemaOrg(post, 'BlogPosting', {
 *   siteUrl: 'https://example.com',
 *   author: { name: 'Jane Doe' },
 * });
 * ```
 */
export function generateSchemaOrg(
  entry: SchemaEntry,
  type: EntrySchemaType,
  options: SchemaOrgOptions
): Record<string, unknown> {
  // Use mapping to ensure exhaustive handling of all schema types
  const schemaGenerators: Record<EntrySchemaType, () => Record<string, unknown>> = {
    Article: () => generateArticleSchema(entry, "Article", options),
    BlogPosting: () => generateArticleSchema(entry, "BlogPosting", options),
    TechArticle: () => generateArticleSchema(entry, "TechArticle", options),
    NewsArticle: () => generateArticleSchema(entry, "NewsArticle", options),
    Product: () => generateProductSchema(entry, options),
    WebPage: () => generateWebPageSchema(entry, options),
  };

  return schemaGenerators[type]();
}

/**
 * Serialize a Schema.org object to JSON-LD string for script tag injection.
 * Uses secure serialization to prevent XSS via </script> injection.
 *
 * @param schema - The Schema.org object to serialize
 * @returns JSON-LD string with dangerous characters escaped
 *
 * @example
 * ```typescript
 * const schema = generateSchemaOrg(post, 'BlogPosting', options);
 * const jsonLd = serializeSchemaOrg(schema);
 * // Use in template: <script type="application/ld+json">{jsonLd}</script>
 * ```
 */
export function serializeSchemaOrg(schema: Record<string, unknown>): string {
  return serializeJsonLd(schema);
}

/**
 * Generate multiple Schema.org objects and merge into a graph.
 *
 * @param schemas - Array of Schema.org objects
 * @returns Combined schema with @graph
 *
 * @example
 * ```typescript
 * const article = generateSchemaOrg(post, 'BlogPosting', options);
 * const breadcrumbs = generateBreadcrumbSchema([...]);
 * const combined = mergeSchemaOrg([article, breadcrumbs]);
 * ```
 */
export function mergeSchemaOrg(schemas: Record<string, unknown>[]): Record<string, unknown> {
  // Remove @context from individual schemas and put in root
  const graph = schemas.map((schema) => {
    const { "@context": _, ...rest } = schema;
    return rest;
  });

  return {
    "@context": "https://schema.org",
    "@graph": graph,
  };
}
