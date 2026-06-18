import { bundleMDX } from "mdx-bundler";
import path from "node:path";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypePrettyCode from "rehype-pretty-code";
import type { Root } from "mdast";
import type { VFile } from "vfile";
import type { Heading, MDXCompileOptions, MDXCompileResult } from "./types";
import {
  calculateReadingTime,
  generateExcerpt,
  normalizePlugins,
  remarkExtractHeadings,
  resolveRawContent,
} from "./extract";

const DEFAULT_WORDS_PER_MINUTE = 250;
const DEFAULT_EXCERPT_LENGTH = 200;

/**
 * Build the `mdxOptions` callback mdx-bundler invokes to assemble its plugin
 * pipeline. Exported for direct testing: it injects our heading-extraction
 * transformer ahead of any caller plugins, so we assert on the resulting arrays
 * without paying for a full bundle.
 */
export function createMdxOptionsBuilder(
  remarkPlugins: unknown,
  rehypePlugins: unknown,
  onHeadingsExtracted: (headings: Heading[]) => void,
) {
  return (mdxOptions: { remarkPlugins?: unknown[]; rehypePlugins?: unknown[] }) => {
    mdxOptions.remarkPlugins = [
      remarkGfm,
      () => (tree: Root, file: VFile) => {
        // remarkExtractHeadings always assigns file.data.headings an array
        // (possibly empty), so the cast below is total — no fallback needed.
        remarkExtractHeadings()(tree, file);
        onHeadingsExtracted(file.data["headings"] as Heading[]);
      },
      ...normalizePlugins(remarkPlugins),
    ];
    mdxOptions.rehypePlugins = [
      rehypeSlug,
      [
        rehypePrettyCode,
        {
          theme: "github-dark",
          keepBackground: true,
          // No transformerCopyButton - copy is handled by React component
        },
      ],
      ...normalizePlugins(rehypePlugins),
    ];
    return mdxOptions;
  };
}

/**
 * Build the `esbuildOptions` callback. Exported for direct testing because the
 * two interesting branches — alias resolution (file mode only) and the
 * NODE_ENV define — are pure transforms on the esbuild config object.
 */
export function createEsbuildOptionsBuilder(options: MDXCompileOptions, isFileMode: boolean) {
  return (esbuildOptions: { alias?: Record<string, string>; define?: Record<string, string> }) => {
    if (
      isFileMode &&
      "aliases" in options &&
      options.aliases &&
      "projectRoot" in options &&
      options.projectRoot
    ) {
      esbuildOptions.alias = {};
      for (const [alias, target] of Object.entries(options.aliases)) {
        const key = alias.replace("/*", "");
        const value = path.resolve(options.projectRoot, target.replace("/*", ""));
        esbuildOptions.alias[key] = value;
      }
    }

    esbuildOptions.define = {
      "process.env.NODE_ENV": JSON.stringify(process.env["NODE_ENV"] ?? "production"),
    };

    return esbuildOptions;
  };
}

/**
 * Wrap a bundler failure with the offending location, preserving the original
 * via `cause`. Non-Error throws (rare, but possible from deep dependencies) are
 * rethrown untouched so we never mask a thrown string or object.
 */
export function handleCompilationError(error: unknown, location: string): never {
  if (error instanceof Error) {
    throw new Error(`MDX compilation failed for ${location}: ${error.message}`, {
      cause: error,
    });
  }
  throw error;
}

/**
 * Compile MDX content to bundled JavaScript.
 *
 * Unlike @volo/content-markdown, this does NOT add copy buttons via transformers.
 * Use the CodeBlock component from @volo/content-mdx/components for copy functionality.
 */
export async function compileMDX(options: MDXCompileOptions): Promise<MDXCompileResult> {
  const {
    remarkPlugins = [],
    rehypePlugins = [],
    wordsPerMinute = DEFAULT_WORDS_PER_MINUTE,
    excerptLength = DEFAULT_EXCERPT_LENGTH,
  } = options;

  const isFileMode = "filePath" in options && options.filePath !== undefined;
  const filePath = isFileMode ? options.filePath : undefined;
  const source = !isFileMode && "source" in options ? options.source : undefined;

  if (!filePath && !source) {
    throw new Error("Either filePath or source must be provided");
  }

  try {
    let extractedHeadings: Heading[] = [];

    const baseOptions = {
      mdxOptions: createMdxOptionsBuilder(remarkPlugins, rehypePlugins, (h) => {
        extractedHeadings = h;
      }),
      esbuildOptions: createEsbuildOptionsBuilder(options, isFileMode),
    };

    const sourceCwd = "cwd" in options && options.cwd ? options.cwd : undefined;
    const bundleOptions = filePath
      ? { ...baseOptions, file: filePath, cwd: path.dirname(filePath) }
      : sourceCwd
        ? { ...baseOptions, source: source!, cwd: sourceCwd }
        : { ...baseOptions, source: source! };

    const { code, frontmatter, matter } = await bundleMDX(bundleOptions);
    const rawContent = resolveRawContent(matter?.content, source);

    return {
      code,
      frontmatter: frontmatter as Record<string, unknown>,
      headings: extractedHeadings,
      readingTime: calculateReadingTime(rawContent, wordsPerMinute),
      excerpt: generateExcerpt(rawContent, excerptLength),
    };
  } catch (error) {
    handleCompilationError(error, filePath ?? "source");
  }
}
