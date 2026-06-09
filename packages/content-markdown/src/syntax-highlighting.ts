/**
 * Shared syntax highlighting utilities for markdown renderers.
 */

import type { SyntaxHighlightingOptions } from "./types";

/**
 * Parse syntax highlighting options into a normalized form.
 */
export function parseSyntaxHighlightingOptions(
  option: boolean | SyntaxHighlightingOptions | undefined
): SyntaxHighlightingOptions | null {
  if (!option) return null;
  if (option === true) {
    return {
      theme: "github-dark",
      keepBackground: true,
      copyButton: true,
    };
  }
  return {
    theme: option.theme ?? "github-dark",
    keepBackground: option.keepBackground ?? true,
    copyButton: option.copyButton ?? true,
  };
}

/**
 * Build the rehype-pretty-code plugin configuration.
 * Only called when syntax highlighting is enabled.
 */
export async function buildSyntaxHighlightingPlugin(options: SyntaxHighlightingOptions) {
  // Lazy import to avoid loading Shiki when not needed
  const [{ default: rehypePrettyCode }, { transformerCopyButton }] = await Promise.all([
    import("rehype-pretty-code"),
    import("@rehype-pretty/transformers"),
  ]);

  const transformers = [];
  if (options.copyButton) {
    const copyButtonOptions = options.copyButton === true
      ? { visibility: "hover" as const, feedbackDuration: 2000 }
      : { visibility: options.copyButton.visibility ?? "hover" as const, feedbackDuration: options.copyButton.feedbackDuration ?? 2000 };
    transformers.push(transformerCopyButton(copyButtonOptions));
  }

  return [
    rehypePrettyCode,
    {
      theme: options.theme,
      keepBackground: options.keepBackground,
      transformers,
    },
  ];
}
