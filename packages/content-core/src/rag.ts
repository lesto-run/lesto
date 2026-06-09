/**
 * RAG Context Primitives for AI Chat Integration
 *
 * Provides framework-agnostic functions for building retrieval-augmented
 * generation (RAG) context from content. Users implement their own chat
 * UI and wire to their preferred AI provider.
 */

import { escapeXml, escapeXmlAttr } from "@keel/content-shared/xml";
import type { RuntimeEntry } from "./types";

// --- Types ---

export interface RAGEntry {
  collection: string;
  slug: string;
  title: string;
  content: string;
  tokenCount: number;
}

export interface RAGContext {
  entries: RAGEntry[];
  totalTokens: number;
  truncated: boolean;
}

export type RAGPrioritization = "recent" | "relevant" | "exemplary";

export interface RAGOptions {
  /** Maximum tokens to include in context. Default: 4000 */
  maxTokens?: number;
  /** How to prioritize content. Default: "relevant" */
  prioritize?: RAGPrioritization;
  /** Include full content or just metadata. Default: true */
  includeContent?: boolean;
  /** Max characters per entry excerpt. Default: 500 */
  excerptLength?: number;
  /** Field to use for title. Default: "title" */
  titleField?: string;
  /** Field to use for date (for "recent" prioritization). Default: "publishedAt" */
  dateField?: string;
  /** Field that marks content as exemplary (for "exemplary" prioritization). Default: "featured" */
  exemplaryField?: string;
}

export type RAGFormat = "markdown" | "xml" | "json";

export interface FormatOptions {
  /** Output format. Default: "markdown" */
  format?: RAGFormat;
  /** Include collection name in output. Default: true */
  includeCollection?: boolean;
}

// --- Token Estimation ---

/**
 * Estimate token count for text using heuristic.
 *
 * Uses a character-to-token ratio approximation. For English text,
 * approximately 4 characters = 1 token on average. This is a
 * conservative estimate that works across GPT and Claude tokenizers.
 *
 * For precise counts, use the tokenizer for your specific model.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Average English word is ~5 characters
  // Average token is ~4 characters
  // Include overhead for whitespace and punctuation
  const charCount = text.length;
  const estimate = Math.ceil(charCount / 4);

  return estimate;
}

// --- Content Extraction ---

function getFieldValue(entry: RuntimeEntry, field: string): unknown {
  return (entry as Record<string, unknown>)[field];
}

function extractTitle(entry: RuntimeEntry, titleField: string): string {
  const title = getFieldValue(entry, titleField);
  if (typeof title === "string" && title.trim()) {
    return title.trim();
  }
  return entry["slug"] as string;
}

function extractContent(entry: RuntimeEntry): string {
  const content = entry["content"];
  if (typeof content === "string") {
    return content;
  }
  return "";
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  // Try to truncate at a sentence boundary
  const truncated = content.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf(".");
  const lastNewline = truncated.lastIndexOf("\n");
  const breakPoint = Math.max(lastPeriod, lastNewline);

  if (breakPoint > maxLength * 0.5) {
    return truncated.slice(0, breakPoint + 1).trim();
  }

  // Fall back to word boundary
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.8) {
    return truncated.slice(0, lastSpace).trim() + "...";
  }

  return truncated.trim() + "...";
}

// --- Prioritization ---

function sortByDate(entries: RuntimeEntry[], dateField: string, descending = true): RuntimeEntry[] {
  return [...entries].toSorted((a, b) => {
    const dateA = getFieldValue(a, dateField);
    const dateB = getFieldValue(b, dateField);

    const timeA =
      dateA instanceof Date
        ? dateA.getTime()
        : typeof dateA === "string"
          ? new Date(dateA).getTime()
          : 0;
    const timeB =
      dateB instanceof Date
        ? dateB.getTime()
        : typeof dateB === "string"
          ? new Date(dateB).getTime()
          : 0;

    return descending ? timeB - timeA : timeA - timeB;
  });
}

function sortByExemplary(entries: RuntimeEntry[], exemplaryField: string): RuntimeEntry[] {
  return [...entries].toSorted((a, b) => {
    const aExemplary = Boolean(getFieldValue(a, exemplaryField));
    const bExemplary = Boolean(getFieldValue(b, exemplaryField));

    if (aExemplary && !bExemplary) return -1;
    if (!aExemplary && bExemplary) return 1;
    return 0;
  });
}

/** Handler registry for prioritization strategies - per AGENTS.md pattern */
const PRIORITIZATION_HANDLERS: Record<
  RAGPrioritization,
  (entries: RuntimeEntry[], dateField: string, exemplaryField: string) => RuntimeEntry[]
> = {
  recent: (entries, dateField) => sortByDate(entries, dateField),
  exemplary: (entries, _dateField, exemplaryField) => sortByExemplary(entries, exemplaryField),
  relevant: (entries, dateField, exemplaryField) => {
    // For "relevant", sort by a combination of recency and exemplary status
    const exemplarySorted = sortByExemplary(entries, exemplaryField);
    // Within each group (exemplary/not), sort by date
    const exemplary = exemplarySorted.filter((e) => Boolean(getFieldValue(e, exemplaryField)));
    const nonExemplary = exemplarySorted.filter((e) => !getFieldValue(e, exemplaryField));
    return [...sortByDate(exemplary, dateField), ...sortByDate(nonExemplary, dateField)];
  },
};

function prioritizeEntries(
  entries: RuntimeEntry[],
  prioritize: RAGPrioritization,
  dateField: string,
  exemplaryField: string,
): RuntimeEntry[] {
  const handler = PRIORITIZATION_HANDLERS[prioritize] ?? PRIORITIZATION_HANDLERS.relevant;
  return handler(entries, dateField, exemplaryField);
}

// --- Context Building ---

/**
 * Build RAG context from entries with token budget management.
 *
 * Prioritizes content based on options and truncates to fit within
 * the token budget. Returns structured context ready for LLM consumption.
 *
 * @param entries - Runtime entries to build context from
 * @param options - Configuration options
 * @returns RAG context with entries and token counts
 *
 * @example
 * ```typescript
 * const docs = getCollection('docs');
 * const context = buildRAGContext(docs, {
 *   maxTokens: 4000,
 *   prioritize: 'recent',
 * });
 * ```
 */
export function buildRAGContext(entries: RuntimeEntry[], options: RAGOptions = {}): RAGContext {
  const {
    maxTokens = 4000,
    prioritize = "relevant",
    includeContent = true,
    excerptLength = 500,
    titleField = "title",
    dateField = "publishedAt",
    exemplaryField = "featured",
  } = options;

  // Prioritize entries
  const sorted = prioritizeEntries(entries, prioritize, dateField, exemplaryField);

  const contextEntries: RAGEntry[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const entry of sorted) {
    const title = extractTitle(entry, titleField);
    const rawContent = includeContent ? extractContent(entry) : "";
    const content = truncateContent(rawContent, excerptLength);

    // Estimate tokens for this entry (title + content + metadata overhead)
    const entryText = `${title}\n${content}`;
    const entryTokens = estimateTokens(entryText) + 10; // overhead for formatting

    // Check if adding this entry would exceed budget
    if (totalTokens + entryTokens > maxTokens) {
      truncated = true;
      break;
    }

    contextEntries.push({
      collection: entry.collection,
      slug: entry["slug"] as string,
      title,
      content,
      tokenCount: entryTokens,
    });

    totalTokens += entryTokens;
  }

  return {
    entries: contextEntries,
    totalTokens,
    truncated,
  };
}

// --- Formatting ---

function formatMarkdown(context: RAGContext, includeCollection: boolean): string {
  if (context.entries.length === 0) {
    return "No relevant content available.";
  }

  const lines: string[] = [];

  for (const entry of context.entries) {
    const prefix = includeCollection ? `[${entry.collection}] ` : "";
    lines.push(`## ${prefix}${entry.title}`);
    if (entry.content) {
      lines.push("");
      lines.push(entry.content);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function formatXml(context: RAGContext, includeCollection: boolean): string {
  if (context.entries.length === 0) {
    return "<context>No relevant content available.</context>";
  }

  const entries = context.entries
    .map((entry) => {
      // Attribute values are escaped with attribute-safe escaping (quotes too)
      // to prevent XML injection via slug/collection containing &, <, >, ", '.
      const collectionAttr = includeCollection
        ? ` collection="${escapeXmlAttr(entry.collection)}"`
        : "";
      const contentTag = entry.content
        ? `\n    <content>${escapeXml(entry.content)}</content>`
        : "";
      return `  <entry${collectionAttr} slug="${escapeXmlAttr(entry.slug)}">
    <title>${escapeXml(entry.title)}</title>${contentTag}
  </entry>`;
    })
    .join("\n");

  return `<context>\n${entries}\n</context>`;
}

function formatJson(context: RAGContext, includeCollection: boolean): string {
  const entries = context.entries.map((entry) => {
    const base: Record<string, string> = {
      slug: entry.slug,
      title: entry.title,
    };
    if (includeCollection) {
      base["collection"] = entry.collection;
    }
    if (entry.content) {
      base["content"] = entry.content;
    }
    return base;
  });

  return JSON.stringify({ entries }, null, 2);
}

/**
 * Format RAG context for LLM consumption.
 *
 * Converts the structured context into a string format suitable
 * for including in an LLM system prompt or message.
 *
 * @param context - The RAG context to format
 * @param options - Formatting options
 * @returns Formatted string for LLM consumption
 *
 * @example
 * ```typescript
 * const context = buildRAGContext(docs, { maxTokens: 4000 });
 * const formatted = formatContextForLLM(context, { format: 'markdown' });
 *
 * const systemPrompt = `You are a helpful assistant. Use this context:
 *
 * ${formatted}`;
 * ```
 */
/** Handler registry for RAG format output - per AGENTS.md pattern */
const FORMAT_HANDLERS: Record<RAGFormat, (ctx: RAGContext, incColl: boolean) => string> = {
  xml: formatXml,
  json: formatJson,
  markdown: formatMarkdown,
};

export function formatContextForLLM(context: RAGContext, options: FormatOptions = {}): string {
  const { format = "markdown", includeCollection = true } = options;
  const handler = FORMAT_HANDLERS[format] ?? FORMAT_HANDLERS.markdown;
  return handler(context, includeCollection);
}
