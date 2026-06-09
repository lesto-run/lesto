import type { FeedEntry } from "./feeds";

export interface LlmsTxtEntry {
  title: string;
  path: string;
  description?: string;
}

export interface LlmsTxtSection {
  heading: string;
  entries: LlmsTxtEntry[];
}

export interface LlmsTxtOptions {
  /** Site/project name (H1 heading) - required */
  name: string;
  /** Short summary of the site (blockquote) */
  description?: string;
  /** Base URL for generating links */
  siteUrl: string;
  /** Additional overview text (appears after blockquote) */
  overview?: string;
  /** Field to use for entry title. Default: "title" */
  titleField?: string;
  /** Field to use for entry description. Default: "description" */
  descriptionField?: string;
  /** Custom URL generator. Default uses collection/slug pattern */
  urlGenerator?: (entry: FeedEntry) => string;
  /** Group entries by collection into sections. Default: true */
  groupByCollection?: boolean;
  /** Custom section name for a collection. Default: uses collection name with title case */
  collectionNames?: Record<string, string>;
  /** Additional custom sections to include after auto-generated ones */
  sections?: LlmsTxtSection[];
  /** Include an "Optional" section with supplementary links */
  optionalSection?: LlmsTxtSection;
}

function getFieldValue(entry: FeedEntry, field: string): unknown {
  return entry[field];
}

function titleCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function normalizeUrl(siteUrl: string): string {
  return siteUrl.replace(/\/$/, "");
}

function formatEntry(entry: LlmsTxtEntry): string {
  const description = entry.description ? `: ${entry.description}` : "";
  return `- [${entry.title}](${entry.path})${description}`;
}

function formatSection(section: LlmsTxtSection): string {
  const lines = [`## ${section.heading}`];
  section.entries.forEach((entry) => {
    lines.push(formatEntry(entry));
  });
  return lines.join("\n");
}

/**
 * Generate llms.txt content following the llmstxt.org specification.
 *
 * @param entries - Runtime entries to include in the file
 * @param options - Configuration options
 * @returns Markdown-formatted llms.txt content
 *
 * @example
 * ```typescript
 * const txt = generateLlmsTxt(getCollection('docs'), {
 *   name: 'My Documentation',
 *   description: 'Comprehensive API docs for MyApp',
 *   siteUrl: 'https://docs.example.com',
 * });
 * ```
 */
export function generateLlmsTxt(entries: FeedEntry[], options: LlmsTxtOptions): string {
  const {
    name,
    description,
    siteUrl,
    overview,
    titleField = "title",
    descriptionField = "description",
    urlGenerator,
    groupByCollection = true,
    collectionNames = {},
    sections = [],
    optionalSection,
  } = options;

  const baseUrl = normalizeUrl(siteUrl);

  const defaultUrlGenerator = (entry: FeedEntry): string => {
    return `${baseUrl}/${entry.collection}/${entry.slug}`;
  };

  const generateUrl = urlGenerator ?? defaultUrlGenerator;

  const lines: string[] = [];

  // H1 heading (required)
  lines.push(`# ${name}`);
  lines.push("");

  // Blockquote summary (optional but recommended)
  if (description) {
    lines.push(`> ${description}`);
    lines.push("");
  }

  // Overview text (optional)
  if (overview) {
    lines.push(overview);
    lines.push("");
  }

  // Group entries by collection or treat as single list
  if (groupByCollection && entries.length > 0) {
    // Group by collection field
    const grouped = entries.reduce<Record<string, FeedEntry[]>>((acc, entry) => {
      const collection = entry.collection;
      if (!acc[collection]) {
        acc[collection] = [];
      }
      acc[collection].push(entry);
      return acc;
    }, {});

    // Generate section for each collection
    Object.entries(grouped).forEach(([collectionName, collectionEntries]) => {
      const sectionName = collectionNames[collectionName] ?? titleCase(collectionName);
      const sectionEntries: LlmsTxtEntry[] = collectionEntries.map((entry) => {
        const desc = getFieldValue(entry, descriptionField);
        const base: LlmsTxtEntry = {
          title: String(getFieldValue(entry, titleField) || entry.slug),
          path: generateUrl(entry),
        };
        if (typeof desc === "string") {
          base.description = desc;
        }
        return base;
      });

      lines.push(formatSection({ heading: sectionName, entries: sectionEntries }));
      lines.push("");
    });
  } else if (entries.length > 0) {
    // Flat list without grouping
    const sectionEntries: LlmsTxtEntry[] = entries.map((entry) => {
      const desc = getFieldValue(entry, descriptionField);
      const base: LlmsTxtEntry = {
        title: String(getFieldValue(entry, titleField) || entry.slug),
        path: generateUrl(entry),
      };
      if (typeof desc === "string") {
        base.description = desc;
      }
      return base;
    });

    lines.push(formatSection({ heading: "Content", entries: sectionEntries }));
    lines.push("");
  }

  // Custom sections
  sections.forEach((section) => {
    lines.push(formatSection(section));
    lines.push("");
  });

  // Optional section (semantic meaning per spec - can be skipped for shorter context)
  if (optionalSection && optionalSection.entries.length > 0) {
    lines.push(formatSection({ heading: "Optional", entries: optionalSection.entries }));
    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}
