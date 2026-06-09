/**
 * Escaping is the whole safety story for a string builder: every value the
 * caller hands us is untrusted text that must not be able to break out of the
 * attribute, element, or document we are weaving it into.
 *
 * We escape the five XML-significant characters. This is a strict superset of
 * what HTML attributes and elements need, so a single routine serves both the
 * HTML (`metaTags`) and XML (`sitemap`) surfaces.
 *
 * The replacements run as a fixed pipeline rather than a regex-with-lookup so
 * that there is no unreachable default arm to leave uncovered — every line
 * here is exercised by escaping any one of the five characters. Ampersand goes
 * first so the ampersands it introduces are never re-touched by later passes.
 */
export function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
