import { assertNoInjection } from "./guard";

/** The shape of a robots.txt directive set. Everything is optional. */
export interface RobotsInput {
  sitemap?: string;
  allow?: string[];
  disallow?: string[];
}

/**
 * Render a robots.txt body.
 *
 * Always opens with `User-agent: *`, then one `Allow:`/`Disallow:` line per
 * path, then a `Sitemap:` line when a sitemap URL is given. With no directives
 * at all, the bare `User-agent: *` line is still a valid (permissive) file.
 *
 * Every path and the sitemap URL is checked for line injection: a `\r`/`\n`
 * (which would smuggle a second directive) or a `#` (which opens a comment) is
 * refused with a coded `SeoError`, never silently written into the file.
 */
export function robots(input: RobotsInput): string {
  const lines: string[] = ["User-agent: *"];

  for (const path of input.allow ?? []) {
    assertNoInjection("Allow path", path);
    lines.push(`Allow: ${path}`);
  }

  for (const path of input.disallow ?? []) {
    assertNoInjection("Disallow path", path);
    lines.push(`Disallow: ${path}`);
  }

  if (input.sitemap !== undefined) {
    assertNoInjection("Sitemap URL", input.sitemap);
    lines.push(`Sitemap: ${input.sitemap}`);
  }

  return lines.join("\n");
}
