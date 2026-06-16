import { SeoError } from "./errors";

/**
 * Refuse a value that would inject structure into a line-oriented or URL
 * surface.
 *
 * A `robots.txt` is line-oriented (a `\r`/`\n` smuggles a second directive; a
 * `#` opens a comment that silently truncates the rest of the line), and a
 * sitemap `<loc>` is a single absolute URL (a newline or a `#` fragment has no
 * legitimate place in it). Both are refused with a stable code rather than
 * stripped, so a caller learns their input was malformed instead of shipping a
 * quietly-mangled file.
 */
export function assertNoInjection(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new SeoError("SEO_INJECTED_NEWLINE", `${field} may not contain a newline.`, {
      field,
      value,
    });
  }

  if (value.includes("#")) {
    throw new SeoError("SEO_INJECTED_FRAGMENT", `${field} may not contain '#'.`, {
      field,
      value,
    });
  }
}
