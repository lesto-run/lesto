import type { FeedItem, FeedMeta } from "./types";

import { rfc3339 } from "./dates";
import { escapeXml } from "./xml";

/**
 * Render a single `<entry>`. Atom requires every entry to carry `<id>`,
 * `<title>`, and `<updated>`. Title comes from the caller; `<id>` is
 * synthesized from the entry link, and `<updated>` from the entry's `published`
 * date or, failing that, the feed's resolved update time (`feedUpdated`).
 */
function renderEntry(item: FeedItem, feedUpdated: string): string {
  const id = item.id ?? item.link;
  const updated = item.published === undefined ? feedUpdated : rfc3339(item.published);

  const lines = [
    `    <title>${escapeXml(item.title)}</title>`,
    `    <link href="${escapeXml(item.link)}"/>`,
    `    <id>${escapeXml(id)}</id>`,
    `    <updated>${escapeXml(updated)}</updated>`,
  ];

  if (item.description !== undefined) {
    lines.push(`    <summary>${escapeXml(item.description)}</summary>`);
  }

  if (item.author !== undefined) {
    lines.push(`    <author><name>${escapeXml(item.author)}</name></author>`);
  }

  return `  <entry>\n${lines.join("\n")}\n  </entry>`;
}

/**
 * Resolve the feed's `<updated>` time: the caller's value if given, else the
 * newest entry's `published`, else now. The result is an RFC 3339 string,
 * reused as the fallback `<updated>` for any entry lacking its own date.
 */
function resolveUpdated(meta: FeedMeta, items: FeedItem[]): string {
  if (meta.updated !== undefined) return rfc3339(meta.updated);

  const dated = items.find((item) => item.published !== undefined);

  if (dated?.published !== undefined) return rfc3339(dated.published);

  return rfc3339(new Date());
}

/**
 * Build a valid Atom 1.0 document for a feed and its entries.
 *
 * Atom 1.0 requires the feed to carry `<id>`, `<title>`, and `<updated>`, and
 * every entry to carry the same three. Titles and links come from the caller;
 * the feed `<id>` is synthesized from its link, `<updated>` from the caller's
 * date (or the newest entry's, or now), and each entry's missing `<id>` /
 * `<updated>` from its link and the feed's update time — so the document is
 * always spec-valid. Dates accept a `Date` and render as RFC 3339; a
 * pre-formatted string is passed through. All text is XML-escaped, in both
 * element text and attribute values.
 */
export function atom(meta: FeedMeta, items: FeedItem[]): string {
  const updated = resolveUpdated(meta, items);

  const head = [
    `  <title>${escapeXml(meta.title)}</title>`,
    `  <link href="${escapeXml(meta.link)}"/>`,
    `  <id>${escapeXml(meta.id ?? meta.link)}</id>`,
    `  <updated>${escapeXml(updated)}</updated>`,
  ];

  if (meta.description !== undefined) {
    head.push(`  <subtitle>${escapeXml(meta.description)}</subtitle>`);
  }

  if (meta.author !== undefined) {
    head.push(`  <author><name>${escapeXml(meta.author)}</name></author>`);
  }

  const body = items.map((item) => renderEntry(item, updated)).join("\n");

  const feedBody = body === "" ? head.join("\n") : `${head.join("\n")}\n${body}`;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<feed xmlns="http://www.w3.org/2005/Atom">`,
    feedBody,
    `</feed>`,
  ].join("\n");
}
