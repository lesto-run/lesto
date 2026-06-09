import { FeedError } from "./errors";

/**
 * Escape a string for safe inclusion in XML character data and attribute values.
 *
 * The five predefined XML entities are the whole job: ampersand first (so we
 * never double-escape the entities we ourselves introduce), then the angle
 * brackets and quotes. The result is safe in both element text and attributes.
 */
export function escapeXml(value: string): string {
  // Invariant: callers hand us strings. A non-string here means a caller bypassed
  // the type system at runtime, and we refuse rather than emit a malformed feed.
  if (typeof value !== "string") {
    throw new FeedError("FEED_UNESCAPABLE_VALUE", "Feed values must be strings.", { value });
  }

  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
