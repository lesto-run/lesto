/**
 * @keel/feeds — RSS 2.0 and Atom 1.0 feed generation.
 *
 *   const xml = rss(
 *     { title: "Keel Blog", link: "https://keel.dev/blog" },
 *     [{ title: "Hello", link: "https://keel.dev/blog/hello" }],
 *   );
 *
 * Pure XML string builders: no dependencies, no I/O. All text is XML-escaped.
 */

export { rss } from "./rss";
export { atom } from "./atom";

export { escapeXml } from "./xml";

export { KeelError, FeedError } from "./errors";
export type { FeedErrorCode } from "./errors";

export type { FeedItem, FeedMeta } from "./types";
