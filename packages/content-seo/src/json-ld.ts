/**
 * JSON-LD API
 *
 * A cleaner, more ergonomic API for generating Schema.org JSON-LD structured data.
 * Returns ready-to-use JSON strings for injection into HTML.
 *
 * @example
 * ```ts
 * import { jsonLd } from "@lesto/content-seo";
 *
 * // Entry-based (auto-extracts fields from content entries)
 * jsonLd.article(entry, options)
 * jsonLd.blogPost(entry, options)
 * jsonLd.newsArticle(entry, options)
 * jsonLd.techArticle(entry, options)
 * jsonLd.product(entry, options)
 * jsonLd.page(entry, options)
 *
 * // Specialized (explicit structured data)
 * jsonLd.faq(items)
 * jsonLd.howTo(name, steps, options?)
 * jsonLd.breadcrumbs(items)
 *
 * // Manual (any Schema.org type, handles @context/@type automatically)
 * jsonLd.create("Person", { name: "Grace Hopper", ... })
 * jsonLd.create("Organization", { name: "Acme Inc", ... })
 *
 * // Combine multiple schemas into @graph
 * jsonLd.graph(
 *   jsonLd.blogPost(entry, options),
 *   jsonLd.breadcrumbs(items)
 * )
 * ```
 */

import { ParseError } from "@lesto/content-shared/errors";
import type { SchemaEntry, SchemaOrgOptions, FAQItem, HowToStep, BreadcrumbItem } from "./types.js";
import {
  generateSchemaOrg,
  generateFAQSchema,
  generateHowToSchema,
  generateBreadcrumbSchema,
  serializeSchemaOrg,
} from "./schema-org.js";

/**
 * JSON-LD namespace for generating Schema.org structured data.
 *
 * All methods return JSON strings ready for injection into a script tag.
 *
 * @example
 * ```tsx
 * // In your component:
 * <script
 *   type="application/ld+json"
 *   dangerouslySetInnerHTML={{ __html: jsonLd.blogPost(entry, options) }}
 * />
 * ```
 */
export const jsonLd = {
  // --- Entry-based methods ---

  /**
   * Generate Article schema from a content entry.
   *
   * @param entry - The entry to generate schema for
   * @param options - Schema.org options including siteUrl, author, publisher
   * @returns JSON-LD string
   */
  article(entry: SchemaEntry, options: SchemaOrgOptions): string {
    const schema = generateSchemaOrg(entry, "Article", options);
    return serializeSchemaOrg(schema);
  },

  /**
   * Generate BlogPosting schema from a content entry.
   *
   * @param entry - The entry to generate schema for
   * @param options - Schema.org options including siteUrl, author, publisher
   * @returns JSON-LD string
   */
  blogPost(entry: SchemaEntry, options: SchemaOrgOptions): string {
    const schema = generateSchemaOrg(entry, "BlogPosting", options);
    return serializeSchemaOrg(schema);
  },

  /**
   * Generate NewsArticle schema from a content entry.
   *
   * @param entry - The entry to generate schema for
   * @param options - Schema.org options including siteUrl, author, publisher
   * @returns JSON-LD string
   */
  newsArticle(entry: SchemaEntry, options: SchemaOrgOptions): string {
    const schema = generateSchemaOrg(entry, "NewsArticle", options);
    return serializeSchemaOrg(schema);
  },

  /**
   * Generate TechArticle schema from a content entry.
   *
   * @param entry - The entry to generate schema for
   * @param options - Schema.org options including siteUrl, author, publisher
   * @returns JSON-LD string
   */
  techArticle(entry: SchemaEntry, options: SchemaOrgOptions): string {
    const schema = generateSchemaOrg(entry, "TechArticle", options);
    return serializeSchemaOrg(schema);
  },

  /**
   * Generate Product schema from a content entry.
   *
   * @param entry - The entry to generate schema for
   * @param options - Schema.org options including siteUrl
   * @returns JSON-LD string
   */
  product(entry: SchemaEntry, options: SchemaOrgOptions): string {
    const schema = generateSchemaOrg(entry, "Product", options);
    return serializeSchemaOrg(schema);
  },

  /**
   * Generate WebPage schema from a content entry.
   *
   * @param entry - The entry to generate schema for
   * @param options - Schema.org options including siteUrl
   * @returns JSON-LD string
   */
  page(entry: SchemaEntry, options: SchemaOrgOptions): string {
    const schema = generateSchemaOrg(entry, "WebPage", options);
    return serializeSchemaOrg(schema);
  },

  // --- Specialized methods ---

  /**
   * Generate FAQ schema from question/answer pairs.
   *
   * @param items - Array of FAQ items with question and answer
   * @returns JSON-LD string
   *
   * @example
   * ```ts
   * jsonLd.faq([
   *   { question: "What is Docks?", answer: "A content layer for modern frameworks." },
   *   { question: "How do I install it?", answer: "npm install @lesto/content-core" },
   * ])
   * ```
   */
  faq(items: FAQItem[]): string {
    const schema = generateFAQSchema(items);
    return serializeSchemaOrg(schema);
  },

  /**
   * Generate HowTo schema from a list of steps.
   *
   * @param name - Name of the how-to guide
   * @param steps - Array of step objects
   * @param options - Optional description and image
   * @returns JSON-LD string
   *
   * @example
   * ```ts
   * jsonLd.howTo("How to make coffee", [
   *   { name: "Boil water", text: "Heat water to 200F" },
   *   { name: "Grind beans", text: "Grind 20g of coffee beans" },
   *   { name: "Brew", text: "Pour water over grounds and wait 4 minutes" },
   * ])
   * ```
   */
  howTo(
    name: string,
    steps: HowToStep[],
    options?: { description?: string; image?: string },
  ): string {
    const schema = generateHowToSchema(name, steps, options);
    return serializeSchemaOrg(schema);
  },

  /**
   * Generate BreadcrumbList schema from navigation items.
   *
   * @param items - Array of breadcrumb items with name and URL
   * @returns JSON-LD string
   *
   * @example
   * ```ts
   * jsonLd.breadcrumbs([
   *   { name: "Home", url: "https://example.com" },
   *   { name: "Blog", url: "https://example.com/blog" },
   *   { name: "My Post", url: "https://example.com/blog/my-post" },
   * ])
   * ```
   */
  breadcrumbs(items: BreadcrumbItem[]): string {
    const schema = generateBreadcrumbSchema(items);
    return serializeSchemaOrg(schema);
  },

  // --- Convenience helpers ---

  /**
   * Generate BlogPosting schema with breadcrumbs in a @graph.
   *
   * This is a convenience helper for the common blog post + breadcrumb pattern.
   *
   * @param entry - The entry to generate schema for
   * @param options - Schema options plus breadcrumb config
   * @returns JSON-LD string with @graph containing BlogPosting and BreadcrumbList
   *
   * @example
   * ```ts
   * jsonLd.postWithBreadcrumbs(post, {
   *   siteUrl: "https://example.com",
   *   sectionName: "Blog",
   *   sectionPath: "/blog",
   *   author: { name: "John Doe" },
   * })
   * ```
   */
  postWithBreadcrumbs(
    entry: SchemaEntry,
    options: SchemaOrgOptions & {
      /** Name of the section (e.g., "Blog", "Posts") */
      sectionName?: string;
      /** Path to the section (e.g., "/blog", "/posts") */
      sectionPath?: string;
    },
  ): string {
    const { sectionName = "Posts", sectionPath = "/posts", ...schemaOptions } = options;
    const siteUrl = schemaOptions.siteUrl.replace(/\/$/, "");
    const slug = (entry as { slug?: string }).slug ?? "";
    const title = (entry as { title?: string }).title ?? "Untitled";

    const postSchema = this.blogPost(entry, schemaOptions);
    const breadcrumbSchema = this.breadcrumbs([
      { name: "Home", url: siteUrl },
      { name: sectionName, url: `${siteUrl}${sectionPath}` },
      { name: title, url: `${siteUrl}${sectionPath}/${slug}` },
    ]);

    return this.graph(postSchema, breadcrumbSchema);
  },

  // --- Manual schema creation ---

  /**
   * Create any Schema.org type with automatic @context and @type.
   *
   * Use this for types not covered by other methods (Person, Organization,
   * Event, Recipe, etc.).
   *
   * @param type - The Schema.org type name
   * @param properties - Properties for the schema
   * @returns JSON-LD string
   *
   * @example
   * ```ts
   * jsonLd.create("Person", {
   *   name: "Grace Hopper",
   *   jobTitle: "Computer Scientist",
   *   url: "https://en.wikipedia.org/wiki/Grace_Hopper",
   * })
   *
   * jsonLd.create("Organization", {
   *   name: "Acme Inc",
   *   url: "https://acme.com",
   *   logo: "https://acme.com/logo.png",
   * })
   *
   * jsonLd.create("Event", {
   *   name: "Tech Conference 2025",
   *   startDate: "2025-03-15",
   *   location: { "@type": "Place", name: "Convention Center" },
   * })
   * ```
   */
  create(type: string, properties: Record<string, unknown>): string {
    const schema = {
      "@context": "https://schema.org",
      "@type": type,
      ...properties,
    };
    return serializeSchemaOrg(schema);
  },

  // --- Graph composition ---

  /**
   * Combine multiple schemas into a single @graph.
   *
   * Accepts JSON strings from other jsonLd methods, parses them,
   * strips individual @context, and wraps in a @graph structure.
   *
   * @param schemas - JSON-LD strings from other jsonLd methods
   * @returns Combined JSON-LD string with @graph
   * @throws ParseError if any schema string is not valid JSON
   *
   * @example
   * ```ts
   * const json = jsonLd.graph(
   *   jsonLd.blogPost(entry, options),
   *   jsonLd.breadcrumbs(breadcrumbItems),
   *   jsonLd.create("Organization", { name: "My Company", ... })
   * );
   * ```
   */
  graph(...schemas: string[]): string {
    if (schemas.length === 0) {
      throw new ParseError("No schemas provided to graph()", { count: 0 });
    }

    const parsedSchemas: Record<string, unknown>[] = [];

    // Iterating with entries() keeps `json` typed as a definite string (no
    // undefined index guard) while still giving us the index for error context.
    for (const [i, json] of schemas.entries()) {
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        // Remove @context from individual schemas
        const { "@context": _, ...rest } = parsed;
        parsedSchemas.push(rest);
      } catch (error) {
        // The catch binding is `unknown`; String() coerces it without an
        // instanceof branch (JSON.parse only throws a SyntaxError anyway).
        throw new ParseError(`Invalid JSON-LD schema at index ${i}`, {
          index: i,
          preview: json.slice(0, 100),
          error: String(error),
        });
      }
    }

    const combined = {
      "@context": "https://schema.org",
      "@graph": parsedSchemas,
    };

    return serializeSchemaOrg(combined);
  },

  // --- Utility methods ---

  /**
   * Parse a JSON-LD string back to an object for manipulation.
   *
   * Useful when you need to modify a schema before combining or re-serializing.
   *
   * @param json - JSON-LD string to parse
   * @returns Schema.org object
   *
   * @example
   * ```ts
   * const schema = jsonLd.parse(jsonLd.blogPost(entry, options));
   * schema.additionalProperty = "value";
   * const modified = JSON.stringify(schema, null, 2);
   * ```
   */
  parse(json: string): Record<string, unknown> {
    return JSON.parse(json) as Record<string, unknown>;
  },
};
