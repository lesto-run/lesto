/**
 * The vocabulary of a syndication feed.
 *
 * A feed is metadata about a channel plus a list of items. The same two shapes
 * feed both RSS 2.0 and Atom 1.0 — the builders differ only in the XML they emit,
 * not in what they know.
 */

/** Channel-level metadata: the feed's own title, link, and optional descriptors. */
export interface FeedMeta {
  readonly title: string;
  readonly link: string;

  readonly description?: string;
  readonly id?: string;
  readonly updated?: string;
  readonly author?: string;
}

/** A single entry in the feed. */
export interface FeedItem {
  readonly title: string;
  readonly link: string;

  readonly id?: string;
  readonly description?: string;
  readonly published?: string;
  readonly author?: string;
}
