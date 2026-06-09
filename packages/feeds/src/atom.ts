import type { FeedItem, FeedMeta } from "./types";

import { escapeXml } from "./xml";

/**
 * Render a single `<entry>`. Required fields (title, link) always appear;
 * optional fields appear only when present.
 */
function renderEntry(item: FeedItem): string {
  const lines = [
    `    <title>${escapeXml(item.title)}</title>`,
    `    <link href="${escapeXml(item.link)}"/>`,
  ];

  if (item.id !== undefined) {
    lines.push(`    <id>${escapeXml(item.id)}</id>`);
  }

  if (item.description !== undefined) {
    lines.push(`    <summary>${escapeXml(item.description)}</summary>`);
  }

  if (item.published !== undefined) {
    lines.push(`    <updated>${escapeXml(item.published)}</updated>`);
  }

  if (item.author !== undefined) {
    lines.push(`    <author><name>${escapeXml(item.author)}</name></author>`);
  }

  return `  <entry>\n${lines.join("\n")}\n  </entry>`;
}

/**
 * Build a valid Atom 1.0 document for a feed and its entries.
 *
 * Required feed fields (title, link) always render; every optional field — on
 * the feed and on each entry — renders only when supplied. All text is
 * XML-escaped, in both element text and attribute values.
 */
export function atom(meta: FeedMeta, items: FeedItem[]): string {
  const head = [
    `  <title>${escapeXml(meta.title)}</title>`,
    `  <link href="${escapeXml(meta.link)}"/>`,
  ];

  if (meta.id !== undefined) {
    head.push(`  <id>${escapeXml(meta.id)}</id>`);
  }

  if (meta.description !== undefined) {
    head.push(`  <subtitle>${escapeXml(meta.description)}</subtitle>`);
  }

  if (meta.updated !== undefined) {
    head.push(`  <updated>${escapeXml(meta.updated)}</updated>`);
  }

  if (meta.author !== undefined) {
    head.push(`  <author><name>${escapeXml(meta.author)}</name></author>`);
  }

  const body = items.map(renderEntry).join("\n");

  const feedBody = body === "" ? head.join("\n") : `${head.join("\n")}\n${body}`;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom">`,
    feedBody,
    `</feed>`,
  ].join("\n");
}
