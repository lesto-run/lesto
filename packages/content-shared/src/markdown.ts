// This module requires optional peer dependencies
// Only import if needed in your package

/**
 * Extract plain text from markdown using AST.
 * Requires: unified, remark-parse, unist-util-visit
 */
export async function extractPlainText(markdown: string): Promise<string> {
  const { unified } = await import("unified");
  const remarkParse = (await import("remark-parse")).default;
  const { toString } = await import("mdast-util-to-string");

  const tree = unified().use(remarkParse).parse(markdown);
  return toString(tree);
}

/**
 * Extract headings from markdown.
 * Requires: unified, remark-parse, unist-util-visit, github-slugger
 */
export interface Heading {
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  slug: string;
}

export async function extractHeadings(
  markdown: string,
  levels: number[] = [1, 2, 3, 4, 5, 6]
): Promise<Heading[]> {
  const { unified } = await import("unified");
  const remarkParse = (await import("remark-parse")).default;
  const { visit } = await import("unist-util-visit");
  const { toString } = await import("mdast-util-to-string");
  const GithubSlugger = (await import("github-slugger")).default;

  const slugger = new GithubSlugger();
  const tree = unified().use(remarkParse).parse(markdown);
  const headings: Heading[] = [];

  visit(tree, "heading", (node) => {
    if (levels.includes(node.depth)) {
      const text = toString(node);
      headings.push({
        depth: node.depth as Heading["depth"],
        text,
        slug: slugger.slug(text),
      });
    }
  });

  return headings;
}

/**
 * Strip frontmatter from markdown content.
 */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length) : content;
}

/**
 * Check if content has YAML frontmatter.
 */
export function hasFrontmatter(content: string): boolean {
  return /^---\r?\n/.test(content);
}

/**
 * Calculate reading time for markdown content.
 */
export interface ReadingTime {
  minutes: number;
  words: number;
  text: string;
}

export async function calculateReadingTime(
  markdown: string,
  wordsPerMinute = 200
): Promise<ReadingTime> {
  const plainText = await extractPlainText(stripFrontmatter(markdown));
  const words = plainText.split(/\s+/).filter(Boolean).length;
  const minutes = Math.ceil(words / wordsPerMinute);

  return {
    minutes,
    words,
    text: minutes === 1 ? "1 min read" : `${minutes} min read`,
  };
}
