import { stripFrontmatter } from "@volo/content-shared/markdown";
import type { ReadingTime } from "./types";

const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;

export function calculateReadingTime(markdown: string, wordsPerMinute: number): ReadingTime {
  const content = stripFrontmatter(markdown);
  const plainText = content.replace(CODE_BLOCK_REGEX, "");
  const words = plainText.split(/\s+/).filter(Boolean).length;
  const minutes = Math.ceil(words / wordsPerMinute);

  return { minutes, words, text: `${minutes} min read` };
}
