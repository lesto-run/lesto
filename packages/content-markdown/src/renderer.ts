import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import { extractHeadings } from "./headings";
import { generateExcerpt } from "./excerpt";
import { calculateReadingTime } from "./reading-time";
import { createHybridRenderer } from "./hybrid-renderer";
import {
  parseSyntaxHighlightingOptions,
  buildSyntaxHighlightingPlugin,
} from "./syntax-highlighting";
import { rehypeStripFirstHeading, remarkStripLumenComments } from "./plugins";
import { rehypeCallouts } from "./callouts";
import type { RenderOptions, RenderResult, Renderer } from "./types";

const DEFAULT_WORDS_PER_MINUTE = 250;
const DEFAULT_EXCERPT_LENGTH = 200;
const DEFAULT_HEADING_LEVELS = [2, 3, 4];

/**
 * Create a unified-based renderer (slower, but supports remark plugins).
 *
 * Use this when you need custom remark plugins for markdown AST manipulation.
 * For most use cases, prefer `createRenderer()` which auto-selects the fastest option.
 */
export function createUnifiedRenderer(options: RenderOptions = {}): Renderer {
  const {
    remarkPlugins = [],
    rehypePlugins = [],
    wordsPerMinute = DEFAULT_WORDS_PER_MINUTE,
    excerptLength = DEFAULT_EXCERPT_LENGTH,
    headingLevels = DEFAULT_HEADING_LEVELS,
    stripFirstHeading = true,
    syntaxHighlighting = false,
    callouts = true,
  } = options;

  const syntaxOptions = parseSyntaxHighlightingOptions(syntaxHighlighting);

  // Cache the processor promise for reuse
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processorPromise: Promise<any> | null = null;

  async function getProcessor() {
    if (processorPromise) return processorPromise;

    processorPromise = (async () => {
      // Build rehype plugins array
      const allRehypePlugins: unknown[] = [rehypeSlug];

      // GitHub-style callouts (only transforms `[!TYPE]` blockquotes)
      if (callouts) {
        allRehypePlugins.push(rehypeCallouts);
      }

      // Only add syntax highlighting if enabled
      if (syntaxOptions) {
        const highlightPlugin = await buildSyntaxHighlightingPlugin(syntaxOptions);
        allRehypePlugins.push(highlightPlugin);
      }

      // Add user plugins
      allRehypePlugins.push(...rehypePlugins);

      // Add strip first heading if enabled
      if (stripFirstHeading) {
        allRehypePlugins.push(rehypeStripFirstHeading);
      }

      return (
        unified()
          .use(remarkParse)
          .use(remarkGfm)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .use(remarkPlugins as any)
          .use(remarkStripLumenComments)
          .use(remarkRehype)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .use(allRehypePlugins as any)
          .use(rehypeStringify)
      );
    })();

    return processorPromise;
  }

  return {
    async render(markdown: string): Promise<RenderResult> {
      const processor = await getProcessor();
      const file = await processor!.process(markdown);
      const html = String(file);

      return {
        html,
        headings: extractHeadings(markdown, headingLevels),
        readingTime: calculateReadingTime(markdown, wordsPerMinute),
        excerpt: generateExcerpt(markdown, excerptLength),
      };
    },
  };
}

/**
 * Create a markdown renderer with automatic optimization.
 *
 * This function automatically selects the best renderer:
 * - **Hybrid (fast)**: Uses md4w + rehype when no remark plugins are specified.
 *   ~44x faster than unified for most content.
 * - **Unified (compatible)**: Uses full remark/rehype pipeline when remark plugins
 *   are specified. Required for custom markdown AST transformations.
 *
 * @example
 * ```ts
 * // Fast path (hybrid) - no remark plugins
 * const renderer = createRenderer();
 * const renderer = createRenderer({ syntaxHighlighting: true });
 *
 * // Slow path (unified) - has remark plugins
 * const renderer = createRenderer({ remarkPlugins: [myPlugin] });
 * ```
 */
export function createRenderer(options: RenderOptions = {}): Renderer {
  const { remarkPlugins = [] } = options;

  // If user provides remark plugins, use unified (they need markdown AST access)
  if (remarkPlugins.length > 0) {
    return createUnifiedRenderer(options);
  }

  // Otherwise, use hybrid renderer (md4w + rehype) for speed
  // Note: We pass through all options except remarkPlugins (not supported in hybrid)
  const { remarkPlugins: _, ...hybridOptions } = options;
  return createHybridRenderer(hybridOptions);
}
