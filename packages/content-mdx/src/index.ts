/**
 * @volo/content-mdx - MDX compilation for React applications
 *
 * This package provides:
 * - MDX compilation via mdx-bundler
 * - Syntax highlighting via rehype-pretty-code
 * - React components for rendering (import from @volo/content-mdx/components)
 *
 * Unlike @volo/content-markdown, this package uses proper React patterns
 * for interactive features like copy buttons.
 *
 * @example
 * ```ts
 * import { compileMDX } from '@volo/content-mdx';
 * import { MDXContent } from '@volo/content-mdx/components';
 *
 * const result = await compileMDX({ source: '# Hello' });
 * // In React: <MDXContent code={result.code} />
 * ```
 */

export { compileMDX } from "./compiler";
export type {
  MDXCompileOptions,
  MDXCompileResult,
  FileCompileOptions,
  SourceCompileOptions,
  Heading,
  ReadingTime,
} from "./types";
