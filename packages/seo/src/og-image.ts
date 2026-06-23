import { escape } from "./escape";
import { SeoError } from "./errors";

/**
 * A dynamic social-preview (Open Graph) image, rendered as a self-contained
 * 1200×630 SVG string — no raster pipeline, no canvas, no satori, just text.
 *
 * Why an SVG string builder and not a PNG? It is the same bet the rest of
 * `@lesto/seo` makes: a pure function with zero dependencies runs anywhere a
 * Lesto site does (the edge, a prerender, a serverless function), the output
 * diffs cleanly in version control, and there is no font-loading or binary
 * step. SVG OG cards render in most modern unfurlers (Google, Slack, Discord);
 * a site that needs a raster everywhere can rasterize this same markup out of
 * band, but the branded card itself lives here as text.
 *
 * Every caller-supplied string is HTML-escaped before it reaches the document,
 * because OG titles and descriptions are routinely attacker-influenced (a page
 * title, a post heading) and an unescaped `<` or `&` in an SVG `<text>` node is
 * a render bug at best and an injection at worst.
 */

const WIDTH = 1200;
const HEIGHT = 630;

const SANS = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** The brand palette for the card. Every field has a sensible Lesto default. */
export interface OgImageColors {
  /** Top-left of the diagonal background gradient. */
  gradientFrom: string;
  /** Bottom-right of the diagonal background gradient. */
  gradientTo: string;
  /** The wordmark + first title line, and the mark tile. */
  title: string;
  /** Title lines after the first. */
  accent: string;
  /** The glyph inside the mark tile. */
  mark: string;
  /** The supporting description line. */
  description: string;
  /** The footer line. */
  footer: string;
}

/** The inputs to a branded OG card. Only `title` is required. */
export interface OgImageInput {
  /**
   * The hero line(s). A single string is one line; an array renders one line
   * per entry (top-down), with lines after the first tinted by `colors.accent`
   * — so a two-part tagline reads as a deliberate emphasis shift.
   */
  title: string | string[];
  /** A supporting line under the title. Omitted when absent. */
  description?: string;
  /** The wordmark beside the mark glyph (e.g. the product name). */
  wordmark?: string;
  /** A footer line, typically the site's domain. Omitted when absent. */
  footer?: string;
  /** Brand colors; any omitted field falls back to the Lesto default. */
  colors?: Partial<OgImageColors>;
}

const DEFAULT_COLORS: OgImageColors = {
  gradientFrom: "#3730a3",
  gradientTo: "#4f46e5",
  title: "#ffffff",
  accent: "#c7d2fe",
  mark: "#4f46e5",
  description: "#e0e7ff",
  footer: "#a5b4fc",
};

/**
 * Render a branded Open Graph card as an SVG document string (1200×630).
 *
 * The package owns the layout — a diagonal gradient, a rounded mark glyph with
 * the wordmark beside it, the title as one or more hero lines, an optional
 * supporting line, and an optional footer. A caller passes its own brand text
 * and colors; a bare `{ title }` still yields a complete, on-brand card.
 *
 * An empty (or whitespace-only) title is refused with a coded `SeoError`,
 * because a card whose hero line is blank is a silent branding failure rather
 * than a thing we should paper over with an empty `<text>` node.
 */
export function ogImage(input: OgImageInput): string {
  const titleLines = (Array.isArray(input.title) ? input.title : [input.title]).map((line) =>
    line.trim(),
  );

  if (titleLines.every((line) => line === "")) {
    throw new SeoError("SEO_EMPTY_OG_TITLE", "OG image title may not be empty.", {
      title: input.title,
    });
  }

  const colors: OgImageColors = { ...DEFAULT_COLORS, ...input.colors };

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<defs>`,
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${escape(colors.gradientFrom)}"/>`,
    `<stop offset="1" stop-color="${escape(colors.gradientTo)}"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>`,
    // The mark — a rounded white tile with the wordmark's initial glyph.
    `<rect x="96" y="96" width="120" height="120" rx="26" fill="${escape(colors.title)}"/>`,
    `<path d="M137 124h17v52h33v16h-50z" fill="${escape(colors.mark)}"/>`,
  ];

  if (input.wordmark !== undefined) {
    parts.push(
      `<text x="240" y="190" font-family="${SANS}" font-size="84" font-weight="800" fill="${escape(colors.title)}">${escape(input.wordmark)}</text>`,
    );
  }

  // The hero lines. The first is the title color; the rest take the accent, so
  // a multi-line tagline reads as a deliberate two-tone emphasis.
  let y = 360;
  titleLines.forEach((line, index) => {
    const fill = index === 0 ? colors.title : colors.accent;
    parts.push(
      `<text x="96" y="${y}" font-family="${SANS}" font-size="60" font-weight="700" fill="${escape(fill)}">${escape(line)}</text>`,
    );
    y += 76;
  });

  if (input.description !== undefined) {
    parts.push(
      `<text x="96" y="${y + 8}" font-family="${SANS}" font-size="32" font-weight="500" fill="${escape(colors.description)}">${escape(input.description)}</text>`,
    );
  }

  if (input.footer !== undefined) {
    parts.push(
      `<text x="96" y="586" font-family="${MONO}" font-size="28" fill="${escape(colors.footer)}">${escape(input.footer)}</text>`,
    );
  }

  parts.push(`</svg>`);

  return parts.join("");
}
