/**
 * @volo/feeds — RSS 2.0 and Atom 1.0 feed generation.
 *
 *   const xml = rss(
 *     { title: "Volo Blog", link: "https://volo.dev/blog" },
 *     [{ title: "Hello", link: "https://volo.dev/blog/hello" }],
 *   );
 *
 * Pure XML string builders: no dependencies, no I/O. All text is XML-escaped.
 */

export { rss } from "./rss";
export { atom } from "./atom";

export { rfc822, rfc3339 } from "./dates";
export type { DateInput } from "./dates";

export { escapeXml } from "./xml";

export { VoloError, FeedError } from "./errors";
export type { FeedErrorCode } from "./errors";

export type { FeedItem, FeedMeta } from "./types";
