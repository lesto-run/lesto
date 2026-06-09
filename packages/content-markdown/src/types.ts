import type { Plugin as UnifiedPlugin } from "unified";
import type { BundledTheme } from "shiki";

export interface SyntaxHighlightingOptions {
  /**
   * Shiki theme to use for syntax highlighting.
   * @default "github-dark"
   */
  theme?: BundledTheme;
  /**
   * Keep the background color from the theme.
   * @default true
   */
  keepBackground?: boolean;
  /**
   * Show a copy button on code blocks.
   * @default true
   */
  copyButton?: boolean | {
    visibility?: "hover" | "always";
    feedbackDuration?: number;
  };
}

export interface RenderOptions {
  remarkPlugins?: UnifiedPlugin[];
  rehypePlugins?: UnifiedPlugin[];
  wordsPerMinute?: number;
  excerptLength?: number;
  headingLevels?: number[];
  /**
   * Remove the first H1 heading from rendered HTML.
   * Useful when the title is already rendered from frontmatter.
   * @default true
   */
  stripFirstHeading?: boolean;
  /**
   * Enable syntax highlighting for code blocks using Shiki.
   *
   * **Performance note**: Syntax highlighting adds significant overhead.
   * Only enable if you need pretty code blocks.
   *
   * @default false
   *
   * @example
   * // Enable with defaults
   * syntaxHighlighting: true
   *
   * @example
   * // Enable with custom options
   * syntaxHighlighting: {
   *   theme: "github-light",
   *   copyButton: { visibility: "always" }
   * }
   */
  syntaxHighlighting?: boolean | SyntaxHighlightingOptions;
}

export interface RenderResult {
  html: string;
  headings: Heading[];
  readingTime: ReadingTime;
  excerpt: string;
}

export interface Heading {
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  slug: string;
  text: string;
}

export interface ReadingTime {
  minutes: number;
  words: number;
  text: string;
}

export interface Renderer {
  render(markdown: string): Promise<RenderResult>;
}
