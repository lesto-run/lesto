import { escapeXml, formatRssDate as formatRssDateSafe } from "@lesto/content-shared/xml";

/**
 * Minimal entry type for feed generation.
 * Any entry with these fields (like typed collection entries) is accepted.
 */
export interface FeedEntry {
  readonly id: string;
  readonly collection: string;
  slug: string;
  [key: string]: unknown;
}

export interface FeedOptions {
  title: string;
  description: string;
  siteUrl: string;
  /** Field to use for entry title. Default: "title" */
  titleField?: string;
  /** Field to use for entry date. Default: "publishedAt" */
  dateField?: string;
  /** Field to use for entry description. Default: "description" */
  descriptionField?: string;
}

function getFieldValue(entry: FeedEntry, field: string): unknown {
  return entry[field];
}

function formatRssDate(date: unknown): string {
  if (!date) return new Date().toUTCString();
  try {
    if (date instanceof Date) {
      return formatRssDateSafe(date);
    }
    if (typeof date === "string" || typeof date === "number") {
      return formatRssDateSafe(date);
    }
  } catch {
    // Invalid date - fall back to current date
  }
  return new Date().toUTCString();
}

export function generateRss(entries: FeedEntry[], options: FeedOptions): string {
  const {
    title,
    description,
    siteUrl,
    titleField = "title",
    dateField = "publishedAt",
    descriptionField = "description",
  } = options;

  const sortedEntries = [...entries]
    .filter((entry) => {
      const dateValue = getFieldValue(entry, dateField);
      return dateValue !== undefined && dateValue !== null;
    })
    .toSorted((a, b) => {
      const dateA = getFieldValue(a, dateField);
      const dateB = getFieldValue(b, dateField);
      const timeA = dateA instanceof Date ? dateA.getTime() : new Date(dateA as string).getTime();
      const timeB = dateB instanceof Date ? dateB.getTime() : new Date(dateB as string).getTime();
      return timeB - timeA;
    })
    .slice(0, 20);

  const items = sortedEntries
    .map((entry) => {
      const entryTitle = getFieldValue(entry, titleField);
      const entryDate = getFieldValue(entry, dateField);
      const entryDescription = getFieldValue(entry, descriptionField);
      const slug = entry.slug;
      const link = `${siteUrl.replace(/\/$/, "")}/${entry.collection}/${slug}`;

      return `    <item>
      <title>${escapeXml(String(entryTitle || slug))}</title>
      <link>${escapeXml(link)}</link>
      <guid>${escapeXml(link)}</guid>
      <pubDate>${formatRssDate(entryDate)}</pubDate>
      ${entryDescription ? `<description>${escapeXml(String(entryDescription))}</description>` : ""}
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>${escapeXml(description)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
}

export function generateSitemap(entries: FeedEntry[], siteUrl: string): string {
  const urls = entries
    .map((entry) => {
      const slug = entry.slug;
      const link = `${siteUrl.replace(/\/$/, "")}/${entry.collection}/${slug}`;
      return `  <url>
    <loc>${escapeXml(link)}</loc>
  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}
