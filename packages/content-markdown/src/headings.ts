import { createSlugger, slugify } from "@lesto/content-shared/slugify";
import { stripFrontmatter } from "@lesto/content-shared/markdown";
import type { Heading } from "./types";

const HEADING_REGEX = /^(#{1,6})\s+(.+)$/gm;
const FENCED_CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
// Match indented code blocks: lines starting with 4+ spaces or tab (after a blank line)
const INDENTED_CODE_BLOCK_REGEX =
  /(?:^|\n\n)((?:[ ]{4}|\t)[^\n]*(?:\n(?:[ ]{4}|\t)[^\n]*|\n(?=[ ]{4}|\t))*)/g;
// Match URLs in heading text to strip them before slugification
const URL_REGEX = /https?:\/\/[^\s)]+/g;

export function extractHeadings(markdown: string, levels: number[]): Heading[] {
  const headings: Heading[] = [];
  const slugger = createSlugger();
  const contentWithoutFrontmatter = stripFrontmatter(markdown);
  const contentWithoutCode = contentWithoutFrontmatter
    .replace(FENCED_CODE_BLOCK_REGEX, "")
    .replace(INDENTED_CODE_BLOCK_REGEX, "");

  HEADING_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = HEADING_REGEX.exec(contentWithoutCode)) !== null) {
    const hashes = match[1];
    const text = match[2];
    if (!hashes || !text) continue;

    const depth = hashes.length as 1 | 2 | 3 | 4 | 5 | 6;
    if (levels.includes(depth)) {
      const trimmedText = text.trim();
      // Strip URLs from text before slugification to avoid overly long slugs
      const textForSlug = trimmedText.replace(URL_REGEX, "").trim();
      headings.push({
        depth,
        text: trimmedText,
        slug: slugify(textForSlug || trimmedText, slugger),
      });
    }
  }

  return headings;
}
