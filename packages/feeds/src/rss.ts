import type { FeedItem, FeedMeta } from "./types";

import { escapeXml } from "./xml";

/**
 * Render a single `<item>`. Required fields (title, link) always appear;
 * optional fields appear only when present, so a bare item stays minimal.
 */
function renderItem(item: FeedItem): string {
  const lines = [
    `      <title>${escapeXml(item.title)}</title>`,
    `      <link>${escapeXml(item.link)}</link>`,
  ];

  if (item.description !== undefined) {
    lines.push(`      <description>${escapeXml(item.description)}</description>`);
  }

  if (item.id !== undefined) {
    lines.push(`      <guid isPermaLink="false">${escapeXml(item.id)}</guid>`);
  }

  if (item.author !== undefined) {
    lines.push(`      <author>${escapeXml(item.author)}</author>`);
  }

  if (item.published !== undefined) {
    lines.push(`      <pubDate>${escapeXml(item.published)}</pubDate>`);
  }

  return `    <item>\n${lines.join("\n")}\n    </item>`;
}

/**
 * Build a valid RSS 2.0 document for a channel and its items.
 *
 * Required channel fields (title, link) always render; every optional field —
 * on the channel and on each item — renders only when supplied. All text is
 * XML-escaped, so untrusted titles and links cannot break the document.
 */
export function rss(meta: FeedMeta, items: FeedItem[]): string {
  const channel = [
    `    <title>${escapeXml(meta.title)}</title>`,
    `    <link>${escapeXml(meta.link)}</link>`,
  ];

  if (meta.description !== undefined) {
    channel.push(`    <description>${escapeXml(meta.description)}</description>`);
  }

  if (meta.id !== undefined) {
    channel.push(`    <guid isPermaLink="false">${escapeXml(meta.id)}</guid>`);
  }

  if (meta.author !== undefined) {
    channel.push(`    <managingEditor>${escapeXml(meta.author)}</managingEditor>`);
  }

  if (meta.updated !== undefined) {
    channel.push(`    <lastBuildDate>${escapeXml(meta.updated)}</lastBuildDate>`);
  }

  const body = items.map(renderItem).join("\n");

  const channelBody = body === "" ? channel.join("\n") : `${channel.join("\n")}\n${body}`;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0">`,
    `  <channel>`,
    channelBody,
    `  </channel>`,
    `</rss>`,
  ].join("\n");
}
