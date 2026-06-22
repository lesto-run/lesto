/**
 * The social-preview (Open Graph) image, as a self-contained SVG.
 *
 * `build.ts` writes the output to `out/docs/og.svg`, and every page's `<head>`
 * points `og:image` / `twitter:image` at it (see `src/app.ts`). Keeping it as a
 * string builder — rather than a checked-in binary — means the wordmark, tagline,
 * and brand colors live in version control as text, diff cleanly, and stay in
 * lockstep with the favicon's indigo mark.
 *
 * NOTE: SVG OG images render in most modern unfurlers (Google, Slack, Discord)
 * but not universally (some Twitter/iMessage paths want a raster). The brand
 * task tracks exporting this same design to a 1200×630 PNG at `out/docs/og.png`
 * as the belt-and-suspenders asset; until then this fixes the blank-card problem
 * everywhere SVG is honored, and the non-image OG/Twitter tags work regardless.
 */

const WIDTH = 1200;
const HEIGHT = 630;

/** Brand indigo, matching the favicon mark in `build.ts`. */
const INDIGO = "#4f46e5";
const INDIGO_DEEP = "#3730a3";

/** Render the Open Graph card as an SVG document string (1200×630). */
export function ogImage(): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<defs>`,
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${INDIGO_DEEP}"/>`,
    `<stop offset="1" stop-color="${INDIGO}"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>`,
    // The "L" mark — the favicon glyph, scaled up, top-left.
    `<rect x="96" y="96" width="120" height="120" rx="26" fill="#ffffff"/>`,
    `<path d="M137 124h17v52h33v16h-50z" fill="${INDIGO}"/>`,
    // Wordmark.
    `<text x="240" y="190" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="84" font-weight="800" fill="#ffffff">Lesto</text>`,
    // Tagline — the hero line.
    `<text x="96" y="360" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="60" font-weight="700" fill="#ffffff">Batteries-included.</text>`,
    `<text x="96" y="436" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="60" font-weight="700" fill="#c7d2fe">Agent-native.</text>`,
    // Supporting line.
    `<text x="96" y="520" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="32" font-weight="500" fill="#e0e7ff">The full-stack TypeScript framework you can drive from Claude.</text>`,
    // Footer URL.
    `<text x="96" y="586" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="28" fill="#a5b4fc">docs.lesto.run</text>`,
    `</svg>`,
  ].join("");
}
