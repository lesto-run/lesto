/**
 * Hybrid renderer: md4w for parsing + rehype for post-processing.
 *
 * This approach gives us:
 * - md4w's speed for markdown → HTML conversion
 * - rehype's plugin ecosystem for HTML transformations
 *
 * Trade-off: We lose remark plugins (markdown AST manipulation),
 * but keep rehype plugins (HTML AST manipulation).
 */
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeOptions } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import * as md4w from "md4w";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractHeadings } from "./headings";
import { generateExcerpt } from "./excerpt";
import { calculateReadingTime } from "./reading-time";
import {
  parseSyntaxHighlightingOptions,
  buildSyntaxHighlightingPlugin,
} from "./syntax-highlighting";
import { rehypeStripFirstHeading } from "./plugins";
import type { RenderOptions, RenderResult, Renderer } from "./types";

const DEFAULT_WORDS_PER_MINUTE = 250;
const DEFAULT_EXCERPT_LENGTH = 200;
const DEFAULT_HEADING_LEVELS = [2, 3, 4];

/**
 * Custom sanitization schema that extends defaultSchema.
 * - Allows id attributes on all elements (rehype-slug adds them to headings)
 * - Disables clobberPrefix to avoid "user-content-" prefix on IDs
 */
const sanitizeSchema: SanitizeOptions = {
  ...defaultSchema,
  // Allow id attribute on all elements
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] || []), "id", "className"],
  },
  // Disable the "user-content-" prefix for IDs
  clobberPrefix: "",
};

// md4w initialization state
let md4wInitPromise: Promise<boolean> | null = null;

/**
 * Get the path to the md4w WASM file.
 * Uses import.meta.resolve to find the actual location in node_modules,
 * which works correctly even when this package is bundled.
 */
function getMd4wWasmPath(): string {
  // Resolve the path to the md4w package
  const md4wEntryPath = import.meta.resolve("md4w");
  const md4wDir = dirname(fileURLToPath(md4wEntryPath));
  return join(md4wDir, "md4w-fast.wasm");
}

/**
 * Initialize md4w WASM with error handling.
 * Returns true if initialization succeeds, false if it fails.
 */
async function ensureMd4wInit(): Promise<boolean> {
  if (!md4wInitPromise) {
    md4wInitPromise = (async () => {
      try {
        const wasmPath = getMd4wWasmPath();
        await md4w.init(new URL(`file://${wasmPath}`));
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `md4w WASM initialization failed, falling back to unified renderer: ${message}`,
        );
        // Reset promise to allow retry on next render
        md4wInitPromise = null;
        return false;
      }
    })();
  }
  return md4wInitPromise;
}

export interface HybridRenderOptions extends Omit<RenderOptions, "remarkPlugins"> {
  // Note: remarkPlugins not supported in hybrid mode - we skip the MDAST layer
}

/**
 * Create a hybrid renderer that uses md4w for speed + rehype for plugins.
 */
export function createHybridRenderer(options: HybridRenderOptions = {}): Renderer {
  const {
    rehypePlugins = [],
    wordsPerMinute = DEFAULT_WORDS_PER_MINUTE,
    excerptLength = DEFAULT_EXCERPT_LENGTH,
    headingLevels = DEFAULT_HEADING_LEVELS,
    stripFirstHeading = true,
    syntaxHighlighting = false,
  } = options;

  const syntaxOptions = parseSyntaxHighlightingOptions(syntaxHighlighting);

  // Cache the processor promise
  let processorPromise: Promise<ReturnType<typeof unified>> | null = null;

  async function getRehypeProcessor() {
    if (processorPromise) return processorPromise;

    processorPromise = (async () => {
      const plugins: unknown[] = [
        [rehypeParse, { fragment: true }], // Parse HTML fragment, not full document
        [rehypeSanitize, sanitizeSchema], // Sanitize HTML to prevent XSS
        rehypeSlug, // Add IDs to headings
      ];

      if (syntaxOptions) {
        const highlightPlugin = await buildSyntaxHighlightingPlugin(syntaxOptions);
        plugins.push(highlightPlugin);
      }

      plugins.push(...rehypePlugins);

      if (stripFirstHeading) {
        plugins.push(rehypeStripFirstHeading);
      }

      plugins.push(rehypeStringify);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return unified().use(plugins as any);
    })();

    return processorPromise;
  }

  // Lazy-loaded fallback renderer (only created if md4w fails)
  let fallbackRenderer: Renderer | null = null;

  async function getFallbackRenderer(): Promise<Renderer> {
    if (!fallbackRenderer) {
      // Dynamic import to avoid circular dependency
      const { createUnifiedRenderer } = await import("./renderer");
      fallbackRenderer = createUnifiedRenderer(options as RenderOptions);
    }
    return fallbackRenderer;
  }

  return {
    async render(markdown: string): Promise<RenderResult> {
      // Handle empty input
      if (!markdown || markdown.trim() === "") {
        return {
          html: "",
          headings: [],
          readingTime: { minutes: 0, words: 0, text: "0 min read" },
          excerpt: "",
        };
      }

      // Ensure md4w is initialized (returns false if init failed)
      const md4wReady = await ensureMd4wInit();
      if (!md4wReady) {
        // Fallback to unified renderer
        const renderer = await getFallbackRenderer();
        return renderer.render(markdown);
      }

      // Step 1: Fast markdown → HTML with md4w
      let html = md4w.mdToHtml(markdown, {
        parseFlags:
          md4w.ParseFlags.DEFAULT |
          md4w.ParseFlags.TABLES |
          md4w.ParseFlags.STRIKETHROUGH |
          md4w.ParseFlags.TASKLISTS,
      });

      // Step 2: Process HTML with rehype (always run for security sanitization)
      const processor = await getRehypeProcessor();
      const file = await processor.process(html);
      html = String(file);

      return {
        html,
        headings: extractHeadings(markdown, headingLevels),
        readingTime: calculateReadingTime(markdown, wordsPerMinute),
        excerpt: generateExcerpt(markdown, excerptLength),
      };
    },
  };
}
