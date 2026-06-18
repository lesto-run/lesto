import { stripFrontmatter } from "@lesto/content-shared/markdown";

export function generateExcerpt(markdown: string, maxLength: number): string {
  const content = stripFrontmatter(markdown);

  // Order matters: images must be stripped before links
  const text = content
    .replace(/#{1,6}\s+/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/\*|_/g, "")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\n+/g, " ")
    .trim();

  if (text.length <= maxLength) return text;

  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 0 ? truncated.slice(0, lastSpace) + "..." : truncated + "...";
}
