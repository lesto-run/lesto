import type { FeedItem, FeedMeta } from "./types";

import { rfc822 } from "./dates";
import { escapeXml } from "./xml";

/**
 * Render a single `<item>`. Required fields (title, link) always appear;
 * optional fields appear only when present, so a bare item stays minimal.
 * A `published` date is emitted as an RFC 822 `<pubDate>`.
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
    lines.push(`      <pubDate>${escapeXml(rfc822(item.published))}</pubDate>`);
  }

  return `    <item>\n${lines.join("\n")}\n    </item>`;
}

/**
 * Build a valid RSS 2.0 document for a channel and its items.
 *
 * RSS 2.0 requires the channel to carry `<title>`, `<link>`, and
 * `<description>`. Title and link come from the caller; `<description>` is
 * synthesized from the title when not supplied, so the document is always
 * spec-valid. Dates (`updated`, item `published`) accept a `Date` and render as
 * RFC 822; a pre-formatted string is passed through. All text is XML-escaped,
 * so untrusted titles and links cannot break the document.
 */
export function rss(meta: FeedMeta, items: FeedItem[]): string {
  const description = meta.description ?? meta.title;

  const channel = [
    `    <title>${escapeXml(meta.title)}</title>`,
    `    <link>${escapeXml(meta.link)}</link>`,
    `    <description>${escapeXml(description)}</description>`,
  ];

  if (meta.id !== undefined) {
    channel.push(`    <guid isPermaLink="false">${escapeXml(meta.id)}</guid>`);
  }

  if (meta.author !== undefined) {
    channel.push(`    <managingEditor>${escapeXml(meta.author)}</managingEditor>`);
  }

  if (meta.updated !== undefined) {
    channel.push(`    <lastBuildDate>${escapeXml(rfc822(meta.updated))}</lastBuildDate>`);
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
