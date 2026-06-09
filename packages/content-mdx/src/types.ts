import type { PluggableList } from "unified";

export interface Heading {
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  slug: string;
}

export interface ReadingTime {
  words: number;
  minutes: number;
  text: string;
}

interface BaseCompileOptions {
  /** Remark plugins to add to the pipeline */
  remarkPlugins?: PluggableList;
  /** Rehype plugins to add to the pipeline */
  rehypePlugins?: PluggableList;
  /** Words per minute for reading time calculation */
  wordsPerMinute?: number;
  /** Maximum length for excerpt */
  excerptLength?: number;
}

export interface FileCompileOptions extends BaseCompileOptions {
  /** Path to the MDX file to compile */
  filePath: string;
  /** Project root for resolving aliases */
  projectRoot?: string;
  /** Path aliases for imports */
  aliases?: Record<string, string>;
}

export interface SourceCompileOptions extends BaseCompileOptions {
  /** MDX source content to compile */
  source: string;
  /** Working directory for resolving imports */
  cwd?: string;
}

export type MDXCompileOptions = FileCompileOptions | SourceCompileOptions;

export interface MDXCompileResult {
  /** Bundled JavaScript code */
  code: string;
  /** Extracted frontmatter */
  frontmatter: Record<string, unknown>;
  /** Extracted headings */
  headings: Heading[];
  /** Calculated reading time */
  readingTime: ReadingTime;
  /** Generated excerpt */
  excerpt: string;
}
