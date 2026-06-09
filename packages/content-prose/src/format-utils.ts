import type { Diagnostic } from './types.js';

/** Box-drawing characters for rich output */
export const BOX = {
  TOP_LEFT: '\u256d', // ╭
  BOTTOM_LEFT: '\u2570', // ╰
  VERTICAL: '\u2502', // │
  HORIZONTAL: '\u2500', // ─
  DOT: '\u00b7', // ·
} as const;

/** Maximum line width before truncation */
export const MAX_LINE_WIDTH = 120;

export interface SnippetLine {
  lineNumber: number;
  content: string;
}

export interface SnippetContext {
  /** Lines of source code to display */
  lines: SnippetLine[];
  /** The primary line index (0-based within lines array) */
  primaryLineIndex: number;
  /** Column where issue starts (1-indexed) */
  column: number;
  /** Length of the underline */
  underlineLength: number;
  /** Label to show under the underline */
  label?: string;
}

/**
 * Extract lines from source content around a given line.
 */
export function extractSnippetLines(
  source: string,
  targetLine: number,
  contextBefore = 1,
  contextAfter = 1
): SnippetLine[] {
  const allLines = source.split('\n');
  const startLine = Math.max(1, targetLine - contextBefore);
  const endLine = Math.min(allLines.length, targetLine + contextAfter);

  const result: SnippetLine[] = [];
  for (let i = startLine; i <= endLine; i++) {
    result.push({
      lineNumber: i,
      content: allLines[i - 1] ?? '',
    });
  }
  return result;
}

/**
 * Infer underline length from diagnostic when length field is missing.
 */
export function inferUnderlineLength(
  diagnostic: Diagnostic,
  lineContent: string
): number {
  // 1. Use explicit length if available
  if (diagnostic.length && diagnostic.length > 0) {
    return diagnostic.length;
  }

  // 2. Extract from quoted text in message (e.g., '"obviously" is a filler')
  const quotedMatch = diagnostic.message.match(/"([^"]+)"/);
  if (quotedMatch?.[1] !== undefined) {
    return quotedMatch[1].length;
  }

  // 3. Use word boundary from column position
  const restOfLine = lineContent.slice(diagnostic.column - 1);
  const wordMatch = restOfLine.match(/^\S+/);
  if (wordMatch) {
    return wordMatch[0].length;
  }

  // 4. Default to single character
  return 1;
}

/**
 * Truncate a long line while preserving the highlighted region.
 */
export function truncateLine(
  content: string,
  column: number,
  length: number,
  maxWidth: number = MAX_LINE_WIDTH
): { content: string; adjustedColumn: number } {
  if (content.length <= maxWidth) {
    return { content, adjustedColumn: column };
  }

  const highlightEnd = column - 1 + length;
  const ellipsis = '...';
  const ellipsisLen = ellipsis.length;

  // Calculate how much space we need around the highlight
  const padding = Math.floor((maxWidth - length - ellipsisLen * 2) / 2);

  const initialStart = Math.max(0, column - 1 - padding);
  const initialEnd = Math.min(content.length, highlightEnd + padding);

  const adjustedBounds = initialStart === 0
    ? { start: 0, end: Math.min(content.length, maxWidth - ellipsisLen) }
    : initialEnd === content.length
      ? { start: Math.max(0, content.length - maxWidth + ellipsisLen), end: content.length }
      : { start: initialStart, end: initialEnd };

  const { start, end } = adjustedBounds;
  const sliced = content.slice(start, end);
  const withLeadingEllipsis = start > 0 ? ellipsis + sliced : sliced;
  const withTrailingEllipsis = end < content.length ? withLeadingEllipsis + ellipsis : withLeadingEllipsis;

  return {
    content: withTrailingEllipsis,
    adjustedColumn: column - start + (start > 0 ? ellipsisLen : 0),
  };
}

/**
 * Render a code snippet with box-drawing gutter.
 * Returns an array of lines to be joined with newlines.
 */
export function renderSnippet(
  ctx: SnippetContext,
  gutterWidth: number
): string[] {
  const output: string[] = [];

  for (let i = 0; i < ctx.lines.length; i++) {
    const snippetLine = ctx.lines[i];
    if (snippetLine === undefined) continue;
    const { lineNumber, content } = snippetLine;
    const lineNumStr = lineNumber.toString().padStart(gutterWidth);

    // Main line with content
    output.push(`${lineNumStr} ${BOX.VERTICAL} ${content}`);

    // Add underline and label for the primary line
    if (i === ctx.primaryLineIndex) {
      const gutterPad = ' '.repeat(gutterWidth);
      const columnPad = ' '.repeat(ctx.column - 1);
      const underline = BOX.HORIZONTAL.repeat(ctx.underlineLength);

      // Underline row
      output.push(`${gutterPad} ${BOX.DOT} ${columnPad}${underline}`);

      // Label row (if provided)
      if (ctx.label) {
        output.push(`${gutterPad} ${BOX.DOT} ${columnPad}${ctx.label}`);
      }
    }
  }

  return output;
}

/**
 * Calculate the gutter width needed for line numbers.
 */
export function calculateGutterWidth(maxLineNumber: number): number {
  return maxLineNumber.toString().length;
}

/** Handler registry for rule label generation - per AGENTS.md pattern */
const LABEL_GENERATORS: Record<string, (word: string) => string> = {
  fillers: (word) => `'${word}' is a filler word`,
  weasel: (word) => `'${word}' is vague`,
  hedge: (word) => `'${word}' hedges your statement`,
  passive: () => `passive voice`,
  adverbs: (word) => `'${word}' is an adverb`,
  repeated: (word) => `'${word}' is repeated`,
  cliches: () => `cliche`,
  simplify: () => `can be simplified`,
  spelling: () => `possible misspelling`,
  profanity: () => `inappropriate language`,
  condescending: () => `condescending tone`,
};

/**
 * Generate a label for the underline based on diagnostic info.
 */
export function generateLabel(diagnostic: Diagnostic): string | undefined {
  // Extract quoted text from message for the label
  const quotedMatch = diagnostic.message.match(/"([^"]+)"/);
  const word = quotedMatch?.[1];
  if (word !== undefined) {
    const generator = LABEL_GENERATORS[diagnostic.rule];
    return generator ? generator(word) : `'${word}' flagged by ${diagnostic.rule}`;
  }
  return undefined;
}
