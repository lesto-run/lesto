/**
 * Extract prose text spans from markdown content.
 *
 * Uses simple regex patterns instead of full AST parsing.
 * This approach is faster and works in web workers (no DOM dependency).
 */

import type { TextSpan } from './types.js';

/**
 * Extract text spans from markdown content.
 * Returns an array of text spans with their original offsets.
 */
export function extract(content: string): TextSpan[] {
  // Step 1: Mark regions to skip
  const skipRanges: Array<{ start: number; end: number }> = [];

  // Find frontmatter (only at start)
  const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (frontmatterMatch) {
    skipRanges.push({ start: 0, end: frontmatterMatch[0].length });
  }

  // Find fenced code blocks (``` or ~~~)
  // Match: opening fence (with optional language), content, closing fence
  // The closing fence must be on its own line
  const codeBlockPattern = /^[ \t]*(```|~~~)([^\n]*)\n([\s\S]*?)\n[ \t]*\1[ \t]*$/gm;
  for (const match of content.matchAll(codeBlockPattern)) {
    skipRanges.push({ start: match.index!, end: match.index! + match[0].length });
  }

  // Find HTML comments
  const commentPattern = /<!--[\s\S]*?-->/g;
  for (const match of content.matchAll(commentPattern)) {
    skipRanges.push({ start: match.index!, end: match.index! + match[0].length });
  }

  // Step 2: Create a working copy with inline elements neutralized
  let workingContent = content;

  // Replace inline code with spaces (preserves offsets)
  workingContent = workingContent.replace(/`[^`\n]+`/g, (m) => ' '.repeat(m.length));

  // Replace image syntax with spaces
  workingContent = workingContent.replace(/!\[([^\]]*)\]\([^)]+\)/g, (m) => ' '.repeat(m.length));

  // Replace link URLs but keep bracket text: [text](url) -> [text]
  workingContent = workingContent.replace(/\]\([^)]+\)/g, (m) => ']' + ' '.repeat(m.length - 1));

  // Replace HTML tags with spaces
  workingContent = workingContent.replace(/<[^>]+>/g, (m) => ' '.repeat(m.length));

  // Replace markdown formatting markers with spaces (bold, italic, strikethrough)
  // Order matters: ** before *, __ before _
  workingContent = workingContent.replace(/\*\*/g, '  ');
  workingContent = workingContent.replace(/__/g, '  ');
  workingContent = workingContent.replace(/(?<!\*)\*(?!\*)/g, ' '); // single * not adjacent to another *
  workingContent = workingContent.replace(/(?<!_)_(?!_)/g, ' '); // single _ not adjacent to another _
  workingContent = workingContent.replace(/~~/g, '  ');

  // Replace brackets from links: [text] -> text (brackets already handled above for URLs)
  workingContent = workingContent.replace(/\[([^\]]*)\]/g, (_m, text: string) => ' ' + text + ' ');

  // Step 3: Sort skip ranges and merge overlapping
  skipRanges.sort((a, b) => a.start - b.start);
  const mergedSkipRanges: Array<{ start: number; end: number }> = [];
  for (const range of skipRanges) {
    const last = mergedSkipRanges[mergedSkipRanges.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      mergedSkipRanges.push({ ...range });
    }
  }

  // Step 4: Extract text spans from non-skipped regions
  const spans: TextSpan[] = [];
  let pos = 0;

  for (const skip of mergedSkipRanges) {
    if (pos < skip.start) {
      // Extract spans from this region
      extractSpansFromRegion(workingContent, pos, skip.start, spans);
    }
    pos = skip.end;
  }

  // Handle remaining content after last skip region
  if (pos < workingContent.length) {
    extractSpansFromRegion(workingContent, pos, workingContent.length, spans);
  }

  return spans;
}

/**
 * Extract text spans from a region of content.
 * Splits on whitespace/punctuation to get individual prose segments.
 */
function extractSpansFromRegion(
  content: string,
  start: number,
  end: number,
  spans: TextSpan[]
): void {
  const region = content.slice(start, end);

  // Split into lines to handle markdown line-level syntax
  const lines = region.split('\n');
  let lineOffset = start;

  for (const line of lines) {
    // Skip markdown headings markers, list markers, blockquote markers
    // but keep the text content
    const textMatch = line.match(/^(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)?(.*)$/);
    const text = textMatch?.[1] ?? line;
    // Calculate prefix length directly - indexOf can return wrong position
    // if the captured text happens to appear earlier in the line
    // e.g., "## ## ##" - indexOf("## ##") returns 0, but prefix is 3 chars
    const textStart = textMatch ? (line.length - text.length) : 0;

    if (text.trim()) {
      // Find contiguous text runs (split by multiple spaces or special chars)
      const textPattern = /[^\s]+(?:\s[^\s]+)*/g;

      for (const textMatch2 of text.matchAll(textPattern)) {
        const spanText = textMatch2[0];
        const spanOffset = lineOffset + textStart + textMatch2.index!;

        // Only add if it contains actual text (not just spaces from our replacements)
        if (spanText.trim()) {
          spans.push({
            text: spanText,
            offset: spanOffset,
          });
        }
      }
    }

    lineOffset += line.length + 1; // +1 for newline
  }
}
