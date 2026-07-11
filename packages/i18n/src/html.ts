/**
 * HTML-escape a string: encode the markup-significant characters so text is
 * safe to write into an HTML document — as element content, or inside a
 * single- or double-quoted attribute.
 *
 * This is the sink `interpolate`/`t` deliberately do NOT apply (see
 * {@link "./interpolate"}): those return plain text on purpose, leaving the
 * correct encoding to whichever sink the caller writes into. `escapeHtml` —
 * and {@link interpolateHtml} / `I18n.tHtml`, which apply it automatically —
 * IS that encoding for the HTML sink, so the common "render a translation
 * straight into markup" path no longer requires the caller to remember it.
 *
 * The replacements run as a fixed pipeline rather than a regex-with-lookup so
 * every line is independently exercised (one character each); ampersand goes
 * first so the ampersands the later passes introduce are never re-escaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
