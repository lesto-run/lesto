import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { resolveConfig } from "../config";

// =============================================================================
// Types
// =============================================================================

export interface WxrImportOptions {
  file: string;
  collection: string;
  cwd: string;
  /** Optional: override directory (skips config resolution, useful for testing) */
  directory?: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: ImportError[];
  files: string[];
}

export interface ImportError {
  title: string;
  reason: string;
}

export interface WxrPost {
  title: string;
  slug: string;
  publishedAt: string;
  content: string;
  excerpt: string;
  status: "publish" | "draft" | "pending" | "private";
  categories: string[];
  tags: string[];
  author?: string;
}

// =============================================================================
// XML Parsing (Simple regex-based parser for WXR structure)
// =============================================================================

function extractCDATA(text: string): string {
  const match = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return match?.[1] ?? text;
}

function extractTagContent(xml: string, tag: string, namespace?: string): string {
  const fullTag = namespace ? `${namespace}:${tag}` : tag;
  const regex = new RegExp(`<${fullTag}[^>]*>([\\s\\S]*?)</${fullTag}>`, "i");
  const match = xml.match(regex);
  if (!match?.[1]) return "";
  return extractCDATA(match[1].trim());
}

function extractCategories(xml: string): { categories: string[]; tags: string[] } {
  const categories: string[] = [];
  const tags: string[] = [];

  const categoryRegex = /<category\s+domain="([^"]+)"[^>]*>([\s\S]*?)<\/category>/gi;
  let match;

  while ((match = categoryRegex.exec(xml)) !== null) {
    const domain = match[1] ?? "";
    const rawContent = match[2]?.trim() ?? "";
    const name = extractCDATA(rawContent);

    if (domain === "category" && name) {
      categories.push(name);
    } else if (domain === "post_tag" && name) {
      tags.push(name);
    }
  }

  return { categories, tags };
}

function extractSlugFromLink(link: string): string {
  const cleaned = link.replace(/\/$/, "");
  const parts = cleaned.split("/");
  return parts[parts.length - 1] || "";
}

export function parseWxrItems(xml: string): WxrPost[] {
  const posts: WxrPost[] = [];

  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;

  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const itemXml = itemMatch[1] ?? "";

    const postType = extractTagContent(itemXml, "post_type", "wp");
    if (postType && postType !== "post" && postType !== "page") {
      continue;
    }

    const title = extractTagContent(itemXml, "title");
    const link = extractTagContent(itemXml, "link");
    const postName = extractTagContent(itemXml, "post_name", "wp");
    const postDate = extractTagContent(itemXml, "post_date", "wp");
    const status = extractTagContent(itemXml, "status", "wp") as WxrPost["status"];
    const content = extractTagContent(itemXml, "encoded", "content");
    const excerpt = extractTagContent(itemXml, "encoded", "excerpt");
    const { categories, tags } = extractCategories(itemXml);

    const authorCreator = extractTagContent(itemXml, "creator", "dc");
    const author = authorCreator || undefined;

    const slug = postName || extractSlugFromLink(link) || slugify(title);

    if (!title && !slug) {
      continue;
    }

    const post: WxrPost = {
      title: title || "Untitled",
      slug,
      publishedAt: postDate || new Date().toISOString(),
      content,
      excerpt,
      status: status || "draft",
      categories,
      tags,
    };
    if (author) {
      post.author = author;
    }
    posts.push(post);
  }

  return posts;
}

// =============================================================================
// HTML to Markdown Conversion - Transformation Registry Pattern
// =============================================================================

type Replacement = string | ((match: string, ...groups: string[]) => string);

/**
 * HTML transformation registry - ordered array of [pattern, replacement] tuples.
 * Transforms are applied sequentially via reduce for immutable processing.
 */
const HTML_TRANSFORMS: ReadonlyArray<readonly [RegExp, Replacement]> = [
  // Normalize line breaks
  [/\r\n/g, "\n"],

  // WordPress shortcodes - remove or extract content
  [/\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/gi, "$1"],
  [/\[gallery[^\]]*\]/gi, ""],
  [/\[audio[^\]]*\]/gi, ""],
  [/\[video[^\]]*\]/gi, ""],

  // Headers h1-h6 - single pattern with dynamic hash generation
  [/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => `\n${"#".repeat(+level)} ${content}\n`],

  // Paragraphs and line breaks
  [/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n"],
  [/<br\s*\/?>/gi, "\n"],

  // Links
  [/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)"],

  // Images - handle attribute order variations
  [/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)"],
  [/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, "![$1]($2)"],
  [/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)"],

  // Text emphasis - consolidate strong/b and em/i
  [/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**"],
  [/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*"],

  // Inline code
  [/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`"],

  // Code blocks - pre+code first, then standalone pre
  [/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n"],
  [/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n"],

  // Blockquotes - requires callback for line-by-line prefixing
  [/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content: string) => {
    const lines = content.trim().split("\n").map((line: string) => `> ${line.trim()}`).join("\n");
    return `\n${lines}\n`;
  }],

  // Unordered lists
  [/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content: string) => {
    return "\n" + content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n").trim() + "\n";
  }],

  // Ordered lists - requires callback for index tracking
  [/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content: string) => {
    let index = 0;
    const result = content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m: string, text: string) => {
      index++;
      return `${index}. ${text.trim()}\n`;
    });
    return "\n" + result.trim() + "\n";
  }],

  // Divs to paragraphs
  [/<div[^>]*>([\s\S]*?)<\/div>/gi, "\n$1\n"],

  // Strip remaining HTML tags
  [/<[^>]+>/g, ""],
] as const;

/**
 * HTML entity decode map for single-pass decoding.
 */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "\u2014",
  "&ndash;": "\u2013",
  "&hellip;": "\u2026",
  "&copy;": "\u00A9",
  "&reg;": "\u00AE",
  "&trade;": "\u2122",
  "&ldquo;": "\u201C",
  "&rdquo;": "\u201D",
  "&lsquo;": "\u2018",
  "&rsquo;": "\u2019",
};

// Pre-compiled regex for named entities (single pass, case-sensitive to match original behavior)
const NAMED_ENTITY_PATTERN = new RegExp(
  Object.keys(HTML_ENTITIES).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "g"
);

/**
 * Decode HTML entities in a single pass using combined pattern.
 */
function decodeEntities(text: string): string {
  return text
    // Named entities - single pass with lookup
    .replace(NAMED_ENTITY_PATTERN, (match) => HTML_ENTITIES[match] ?? match)
    // Numeric decimal entities
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    // Numeric hex entities
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Convert HTML content to Markdown using transformation registry.
 * Uses immutable reduce pattern instead of sequential mutations.
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return "";

  // Apply all transformations via reduce
  const transformed = HTML_TRANSFORMS.reduce(
    (md, [pattern, replacement]) => md.replace(pattern, replacement as string),
    html
  );

  // Decode entities and clean up whitespace
  return decodeEntities(transformed)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// =============================================================================
// File Generation
// =============================================================================

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr.replace(" ", "T"));
  if (isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function generateFrontmatter(post: WxrPost): string {
  const lines = ["---"];

  lines.push(`title: ${JSON.stringify(post.title)}`);
  lines.push(`publishedAt: "${formatDate(post.publishedAt)}"`);

  if (post.excerpt) {
    lines.push(`description: ${JSON.stringify(post.excerpt)}`);
  }

  lines.push(`draft: ${post.status !== "publish"}`);

  if (post.categories.length > 0) {
    lines.push(`categories: ${JSON.stringify(post.categories)}`);
  }

  if (post.tags.length > 0) {
    lines.push(`tags: ${JSON.stringify(post.tags)}`);
  }

  if (post.author) {
    lines.push(`author: ${JSON.stringify(post.author)}`);
  }

  lines.push("---");

  return lines.join("\n");
}

function generateMarkdownFile(post: WxrPost): string {
  const frontmatter = generateFrontmatter(post);
  const content = htmlToMarkdown(post.content);

  return `${frontmatter}

${content}
`;
}

// =============================================================================
// Main Import Function
// =============================================================================

async function resolveCollectionDirectory(
  cwd: string,
  collection: string,
  directory?: string,
): Promise<string> {
  if (directory) {
    return path.isAbsolute(directory) ? directory : path.join(cwd, directory);
  }

  const config = await resolveConfig(cwd);
  const collectionConfig = config.collections.find((c) => c.name === collection);

  if (!collectionConfig) {
    throw new Error(
      `Collection "${collection}" not found. Available: ${config.collections.map((c) => c.name).join(", ")}`
    );
  }

  return path.join(cwd, collectionConfig.directory);
}

async function importSinglePost(
  post: WxrPost,
  collectionDir: string,
  result: ImportResult,
): Promise<void> {
  const fileName = `${post.slug}.md`;
  const filePath = path.join(collectionDir, fileName);

  try {
    await access(filePath);
    result.skipped++;
    result.errors.push({ title: post.title, reason: `File already exists: ${fileName}` });
    return;
  } catch {}

  try {
    const content = generateMarkdownFile(post);
    await writeFile(filePath, content, "utf-8");
    result.imported++;
    result.files.push(filePath);
  } catch (err) {
    result.errors.push({
      title: post.title,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function importWordPress(options: WxrImportOptions): Promise<ImportResult> {
  const { file, collection, cwd, directory } = options;

  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    errors: [],
    files: [],
  };

  const collectionDir = await resolveCollectionDirectory(cwd, collection, directory);
  const wxrPath = path.isAbsolute(file) ? file : path.join(cwd, file);
  const wxrContent = await readFile(wxrPath, "utf-8");
  const posts = parseWxrItems(wxrContent);

  if (posts.length === 0) {
    return result;
  }

  await mkdir(collectionDir, { recursive: true });

  for (const post of posts) {
    await importSinglePost(post, collectionDir, result);
  }

  return result;
}
