/**
 * The vocabulary of a syndication feed.
 *
 * A feed is metadata about a channel plus a list of items. The same two shapes
 * feed both RSS 2.0 and Atom 1.0 — the builders differ only in the XML they emit,
 * not in what they know.
 *
 * Date-bearing fields accept either a `Date` (formatted to the feed's dialect —
 * RFC 822 for RSS, RFC 3339 for Atom) or a string the caller has already
 * formatted, which is trusted as-is.
 */

import type { DateInput } from "./dates";

/**
 * Channel-level metadata: the feed's own title, link, and optional descriptors.
 *
 * Only `title` and `link` are required of the caller. The fields a valid feed
 * cannot omit — RSS `<description>`, Atom `<id>` and `<updated>` — are
 * synthesized from what is present (description ← title, id ← link, updated ←
 * the first dated item or now) when not supplied, so every emitted document is spec-valid.
 */
export interface FeedMeta {
  readonly title: string;
  readonly link: string;

  readonly description?: string;
  readonly id?: string;
  readonly updated?: DateInput;
  readonly author?: string;
}

/**
 * A single entry in the feed.
 *
 * Atom requires an entry `<id>` and `<updated>`; both are synthesized (id ←
 * link, updated ← the feed's resolved update time) when not supplied.
 */
export interface FeedItem {
  readonly title: string;
  readonly link: string;

  readonly id?: string;
  readonly description?: string;
  readonly published?: DateInput;
  readonly author?: string;
}
