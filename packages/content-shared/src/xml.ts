import he from "he";

/**
 * Escape text for safe inclusion in XML content.
 * Handles all XML special characters and unicode.
 */
export function escapeXml(text: string): string {
  return he.escape(text);
}

/**
 * Decode XML entities back to text.
 */
export function decodeXml(text: string): string {
  return he.decode(text);
}

/**
 * Escape text for use in XML attributes (includes quotes).
 * Uses named references for better readability.
 */
export function escapeXmlAttr(text: string): string {
  return he.encode(text, { useNamedReferences: true });
}

/**
 * Create a CDATA section for content that shouldn't be escaped.
 * Handles the edge case of ]]> appearing in content.
 */
export function wrapCdata(content: string): string {
  // Split on ]]> and rejoin with separate CDATA sections
  const parts = content.split("]]>");
  if (parts.length === 1) {
    return `<![CDATA[${content}]]>`;
  }
  return parts.map((part) => `<![CDATA[${part}]]>`).join("]]>");
}

/**
 * Format a date for XML (ISO 8601 format).
 */
export function formatXmlDate(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  return d.toISOString();
}

/**
 * Format a date for RSS feeds (RFC 822 format).
 */
export function formatRssDate(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  return d.toUTCString();
}
