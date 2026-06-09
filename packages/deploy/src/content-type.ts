/**
 * The Content-Type a static file should be served with.
 *
 * A CDN serves bytes; the only thing it needs from us per file is the media
 * type, and the only honest signal we have offline is the extension. We keep a
 * small, explicit table of the types a prerendered site actually emits — pages,
 * feeds, assets — rather than pull in a mime database we'd use a dozen rows of.
 */

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** Extension (without the dot) -> Content-Type, for the types a site emits. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
};

/**
 * The Content-Type for a file, by its extension.
 *
 * The lookup is case-insensitive (`INDEX.HTML` is still HTML); a file with no
 * extension, or one we don't recognize, falls back to a safe binary type so the
 * CDN serves the bytes verbatim rather than guess.
 */
export function contentTypeFor(file: string): string {
  const dot = file.lastIndexOf(".");

  // No dot, or a trailing dot with nothing after it — nothing to key on.
  if (dot < 0 || dot === file.length - 1) return DEFAULT_CONTENT_TYPE;

  const extension = file.slice(dot + 1).toLowerCase();

  return BY_EXTENSION[extension] ?? DEFAULT_CONTENT_TYPE;
}
