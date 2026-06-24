/**
 * The social-preview (Open Graph) image, as a self-contained SVG.
 *
 * the `lesto.build.ts` build hook writes the output to `out/docs/og.svg`, and every page's `<head>`
 * points `og:image` / `twitter:image` at it (see `src/app.ts`). The card's
 * layout — gradient, mark glyph, wordmark, hero lines, footer — lives in
 * `@lesto/seo`'s `ogImage`, so any Lesto site gets a branded card; this module
 * only supplies the Lesto brand inputs (wordmark, tagline, colors). Keeping it
 * a string builder — rather than a checked-in binary — means the brand text and
 * colors stay in version control as text, diff cleanly, and stay in lockstep
 * with the favicon's indigo mark.
 *
 * NOTE: SVG OG images render in most modern unfurlers (Google, Slack, Discord)
 * but not universally (some Twitter/iMessage paths want a raster). The brand
 * task tracks exporting this same design to a 1200×630 PNG at `out/docs/og.png`
 * as the belt-and-suspenders asset; until then this fixes the blank-card problem
 * everywhere SVG is honored, and the non-image OG/Twitter tags work regardless.
 */

import { ogImage as brandedOgImage } from "@lesto/seo";

/** Brand indigo, matching the favicon mark in `lesto.build.ts`. */
const INDIGO = "#4f46e5";
const INDIGO_DEEP = "#3730a3";

/** Render the Lesto Open Graph card as an SVG document string (1200×630). */
export function ogImage(): string {
  return brandedOgImage({
    wordmark: "Lesto",
    // The hero line — the brand tagline, split for a two-tone emphasis shift.
    title: ["Batteries-included.", "Agent-native."],
    description: "The full-stack TypeScript framework you can drive from Claude.",
    footer: "docs.lesto.run",
    colors: {
      gradientFrom: INDIGO_DEEP,
      gradientTo: INDIGO,
      title: "#ffffff",
      accent: "#c7d2fe",
      mark: INDIGO,
      description: "#e0e7ff",
      footer: "#a5b4fc",
    },
  });
}
