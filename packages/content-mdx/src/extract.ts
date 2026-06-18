import { visit } from "unist-util-visit";
import { createSlugger } from "@volo/content-shared/slugify";
import type { Root, PhrasingContent } from "mdast";
import type { VFile } from "vfile";
import type { Heading, ReadingTime } from "./types";

/**
 * Pure extraction + measurement helpers for MDX content.
 *
 * These live apart from the compiler so they can be exercised directly: the
 * compiler's only job is to wire mdx-bundler, while the interesting branching
 * (slug collisions, reading-time rounding, excerpt truncation) is pure text
 * work that deserves its own focused tests.
 */

/**
 * Flatten a heading node's children to its visible text.
 *
 * A heading can nest arbitrarily — `## A **bold** [link](/x)` — so we recurse
 * through any node that carries `children`, collecting the leaf `text` and
 * `inlineCode` values. Everything else (e.g. images) contributes nothing.
 */
export function extractTextFromChildren(children: PhrasingContent[]): string {
  return children
    .map((child) => {
      if (child.type === "text") return child.value;
      if (child.type === "inlineCode") return child.value;
      if ("children" in child) return extractTextFromChildren(child.children as PhrasingContent[]);
      return "";
    })
    .join("");
}

/**
 * Remark transformer that records every heading into `file.data.headings`.
 *
 * A single slugger instance is shared across the document so duplicate heading
 * text gets the github-flavored `-1`, `-2` … disambiguation, matching the slugs
 * rehype-slug stamps onto the rendered anchors.
 */
export function remarkExtractHeadings() {
  return (tree: Root, file: VFile) => {
    const headings: Heading[] = [];
    const slugger = createSlugger();

    visit(tree, "heading", (node) => {
      const text = node.children
        .map((child) => {
          if (child.type === "text") return child.value;
          if (child.type === "inlineCode") return child.value;
          if ("children" in child) {
            return extractTextFromChildren(child.children);
          }
          return "";
        })
        .join("")
        .trim();

      // A heading with no extractable text (e.g. `## ![alt](img)`) carries no
      // anchor target, so it is intentionally dropped rather than slugged to "".
      if (text) {
        headings.push({
          depth: node.depth as 1 | 2 | 3 | 4 | 5 | 6,
          text,
          slug: slugger.slug(text),
        });
      }
    });

    file.data["headings"] = headings;
  };
}

/**
 * Coerce a plugin option into an array.
 *
 * mdx-bundler accepts a single pluggable or a list; callers may also pass
 * nothing. We normalize all three shapes so the pipeline can spread freely.
 */
export function normalizePlugins(plugins: unknown): unknown[] {
  if (plugins == null) return [];
  return Array.isArray(plugins) ? plugins : [plugins];
}

/**
 * Estimate reading time from raw content.
 *
 * Words are whitespace-delimited and rounded UP to whole minutes — a 10-word
 * post still reads as "1 min read". Genuinely empty content rounds to zero
 * minutes, which we surface as the friendlier "< 1 min read".
 */
export function calculateReadingTime(content: string, wordsPerMinute: number): ReadingTime {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  const minutes = Math.ceil(words / wordsPerMinute);
  const text = minutes === 0 ? "< 1 min read" : `${minutes} min read`;
  return { words, minutes, text };
}

/**
 * Pick the raw, frontmatter-stripped content to measure and excerpt from.
 *
 * mdx-bundler returns the body (sans frontmatter) on `matter.content`; we prefer
 * it, falling back to the original `source` (when compiling a string) and then
 * to an empty string (e.g. a file with no readable matter). The fallbacks are
 * defensive against bundler edge cases, hence the dedicated branch coverage.
 */
export function resolveRawContent(
  matterContent: string | undefined,
  source: string | undefined,
): string {
  return matterContent ?? source ?? "";
}

/**
 * Derive a plain-text excerpt from raw (still-marked-up) content.
 *
 * We strip the leading frontmatter block, heading markers, link syntax (keeping
 * the label), and inline emphasis/code marks, then collapse newlines. If the
 * result fits, it is returned whole; otherwise it is cut to `length`, trimmed
 * back to a word boundary, and suffixed with an ellipsis so we never slice a
 * word in half.
 */
export function generateExcerpt(content: string, length: number): string {
  const plainText = content
    .replace(/^---[\s\S]*?---/m, "")
    .replace(/#+\s/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\n+/g, " ")
    .trim();

  if (plainText.length <= length) return plainText;
  return plainText.slice(0, length).replace(/\s+\S*$/, "") + "...";
}
