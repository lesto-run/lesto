import { bundleMDX } from "mdx-bundler";
import path from "node:path";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypePrettyCode from "rehype-pretty-code";
import { visit } from "unist-util-visit";
import { createSlugger } from "@keel/content-shared/slugify";
import type { Root, PhrasingContent } from "mdast";
import type { VFile } from "vfile";
import type { Heading, MDXCompileOptions, MDXCompileResult } from "./types";

const DEFAULT_WORDS_PER_MINUTE = 250;
const DEFAULT_EXCERPT_LENGTH = 200;

/**
 * Remark plugin to extract headings from the MDX AST.
 * Uses github-slugger to handle duplicate headings correctly.
 */
function remarkExtractHeadings() {
  return (tree: Root, file: VFile) => {
    const headings: Heading[] = [];
    const slugger = createSlugger();

    visit(tree, "heading", (node) => {
      const text = node.children
        .map((child) => {
          if (child.type === "text") return child.value;
          if (child.type === "inlineCode") return child.value;
          if ("children" in child) {
            return extractTextFromChildren(child.children);
          }
          return "";
        })
        .join("")
        .trim();

      if (text) {
        headings.push({
          depth: node.depth as 1 | 2 | 3 | 4 | 5 | 6,
          text,
          slug: slugger.slug(text),
        });
      }
    });

    file.data["headings"] = headings;
  };
}

function extractTextFromChildren(children: PhrasingContent[]): string {
  return children
    .map((child) => {
      if (child.type === "text") return child.value;
      if (child.type === "inlineCode") return child.value;
      if ("children" in child) return extractTextFromChildren(child.children as PhrasingContent[]);
      return "";
    })
    .join("");
}

function normalizePlugins(plugins: unknown): unknown[] {
  if (plugins == null) return [];
  return Array.isArray(plugins) ? plugins : [plugins];
}

function calculateReadingTime(content: string, wordsPerMinute: number) {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  const minutes = Math.ceil(words / wordsPerMinute);
  const text = minutes === 0 ? "< 1 min read" : `${minutes} min read`;
  return { words, minutes, text };
}

function generateExcerpt(content: string, length: number): string {
  const plainText = content
    .replace(/^---[\s\S]*?---/m, "")
    .replace(/#+\s/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\n+/g, " ")
    .trim();

  if (plainText.length <= length) return plainText;
  return plainText.slice(0, length).replace(/\s+\S*$/, "") + "...";
}

function createMdxOptionsBuilder(
  remarkPlugins: unknown,
  rehypePlugins: unknown,
  onHeadingsExtracted: (headings: Heading[]) => void,
) {
  return (mdxOptions: { remarkPlugins?: unknown[]; rehypePlugins?: unknown[] }) => {
    mdxOptions.remarkPlugins = [
      remarkGfm,
      () => (tree: Root, file: VFile) => {
        remarkExtractHeadings()(tree, file);
        onHeadingsExtracted((file.data["headings"] as Heading[]) || []);
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

function createEsbuildOptionsBuilder(options: MDXCompileOptions, isFileMode: boolean) {
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

function handleCompilationError(error: unknown, location: string): never {
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
 * Unlike @keel/content-markdown, this does NOT add copy buttons via transformers.
 * Use the CodeBlock component from @keel/content-mdx/components for copy functionality.
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
    const rawContent = matter?.content ?? source ?? "";

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
