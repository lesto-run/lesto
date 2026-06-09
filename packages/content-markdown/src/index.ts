/**
 * @keel/content-markdown - High-performance markdown rendering.
 *
 * This package handles .md files only. Output is HTML rendered via
 * dangerouslySetInnerHTML, so inline event handlers work correctly.
 *
 * For .mdx files, use @keel/content-mdx which provides React-compatible components.
 *
 * ## Performance
 *
 * The default `createRenderer()` automatically selects the fastest renderer:
 * - **Hybrid mode** (default): Uses md4w (WASM) + rehype. ~44x faster than unified.
 * - **Unified mode**: Falls back when remark plugins are specified.
 *
 * Syntax highlighting via Shiki is opt-in (disabled by default).
 *
 * @example
 * ```ts
 * import { createRenderer } from '@keel/content-markdown';
 *
 * // Fast path (hybrid) - recommended for most use cases
 * const renderer = createRenderer();
 * const result = await renderer.render('# Hello World');
 *
 * // With syntax highlighting
 * const renderer = createRenderer({ syntaxHighlighting: true });
 *
 * // Slow path (unified) - only when remark plugins are needed
 * const renderer = createRenderer({ remarkPlugins: [myPlugin] });
 * ```
 */

export { createRenderer, createUnifiedRenderer } from "./renderer";
export { createHybridRenderer } from "./hybrid-renderer";
export { extractHeadings } from "./headings";
export { generateExcerpt } from "./excerpt";
export { calculateReadingTime } from "./reading-time";
export type {
  RenderOptions,
  RenderResult,
  Heading,
  ReadingTime,
  Renderer,
  SyntaxHighlightingOptions,
} from "./types";
