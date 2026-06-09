import pc from 'picocolors';
import type { LintResult, RichLintResult, Diagnostic } from './types.js';
import {
  BOX,
  extractSnippetLines,
  inferUnderlineLength,
  truncateLine,
  renderSnippet,
  calculateGutterWidth,
  generateLabel,
  MAX_LINE_WIDTH,
} from './format-utils.js';

/**
 * Type guard to check if result is a RichLintResult
 */
function isRichResult(result: LintResult | RichLintResult): result is RichLintResult {
  return 'sources' in result && result.sources instanceof Map;
}

export function format(result: LintResult | RichLintResult, type: string): string {
  if (type === 'github') return formatGitHub(result);
  if (type === 'stylish') return formatStylish(result);
  // Default to rich if sources available, otherwise stylish
  if (isRichResult(result)) return formatRich(result);
  return formatStylish(result);
}

/** Group diagnostics by file - mutate accumulator for O(n) performance */
function groupByFile(diagnostics: Diagnostic[]): Map<string, Diagnostic[]> {
  return diagnostics.reduce((byFile, d) => {
    const arr = byFile.get(d.file) ?? [];
    arr.push(d);
    byFile.set(d.file, arr);
    return byFile;
  }, new Map<string, Diagnostic[]>());
}

/** Format severity label */
function formatSeverityLabel(severity: string): string {
  return severity === 'error' ? pc.red('error') + '  ' : pc.yellow('warning');
}

/** Format file diagnostics section */
function formatFileDiagnostics(file: string, diags: Diagnostic[]): string[] {
  const output: string[] = [pc.underline(file)];
  const maxLocLen = Math.max(...diags.map(d => `${d.line}:${d.column}`.length));
  const maxMsgLen = Math.max(...diags.map(d => d.message.length));

  for (const d of diags) {
    const loc = pc.dim(`${d.line}:${d.column}`.padStart(maxLocLen));
    const msg = d.message.padEnd(maxMsgLen);
    output.push(`  ${loc}  ${formatSeverityLabel(d.severity)}  ${msg}  ${pc.dim(`[${d.rule}]`)}`);
  }
  output.push('');
  return output;
}

/** Format issue count summary */
function formatIssueSummary(errorCount: number, warningCount: number): string {
  const parts: string[] = [];
  if (errorCount > 0) parts.push(pc.red(`${errorCount} error${errorCount === 1 ? '' : 's'}`));
  if (warningCount > 0) parts.push(pc.yellow(`${warningCount} warning${warningCount === 1 ? '' : 's'}`));
  return parts.length > 0 ? `✗ ${parts.join(', ')}` : pc.green('✓ No issues');
}

function formatStylish(result: LintResult): string {
  if (result.diagnostics.length === 0) return pc.green('✓ No issues');

  const byFile = groupByFile(result.diagnostics);
  const output: string[] = [];

  for (const [file, diags] of byFile) {
    output.push(...formatFileDiagnostics(file, diags));
  }

  output.push(formatIssueSummary(result.errorCount, result.warningCount));
  return output.join('\n');
}

function formatGitHub(result: LintResult): string {
  return result.diagnostics
    .map(d => `::${d.severity} file=${d.file},line=${d.line},col=${d.column}::${d.message}`)
    .join('\n');
}

/**
 * Format lint results in rich oxlint-style output with code snippets.
 */
function formatRich(result: RichLintResult): string {
  if (result.diagnostics.length === 0) {
    return formatRichSummary(result);
  }

  const output: string[] = [];

  // Sort diagnostics by file, then by line
  const sortedDiags = [...result.diagnostics].toSorted((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  for (const diagnostic of sortedDiags) {
    output.push(formatRichDiagnostic(diagnostic, result.sources));
    output.push(''); // Blank line between diagnostics
  }

  output.push(formatRichSummary(result));

  return output.join('\n');
}

/** Get severity icon for diagnostic */
function getSeverityIcon(severity: string): string {
  return severity === 'error' ? pc.red('\u2717') : pc.yellow('\u26a0');
}

/** Format diagnostic header line */
function formatDiagnosticHeader(diagnostic: Diagnostic): string {
  const icon = getSeverityIcon(diagnostic.severity);
  const ruleName = pc.cyan(diagnostic.rule);
  return `${icon} ${pc.bold('prose')}(${ruleName}): ${diagnostic.message}`;
}

/** Process snippet lines for display, handling long lines */
function processSnippetLines(
  snippetLines: Array<{ lineNumber: number; content: string }>,
  diagnostic: Diagnostic,
  underlineLength: number
): { processedLines: Array<{ lineNumber: number; content: string }>; displayColumn: number } {
  let displayColumn = diagnostic.column;
  const processedLines = snippetLines.map(line => {
    if (line.content.length <= MAX_LINE_WIDTH) return line;
    if (line.lineNumber === diagnostic.line) {
      const { content, adjustedColumn } = truncateLine(
        line.content, diagnostic.column, underlineLength, MAX_LINE_WIDTH
      );
      displayColumn = adjustedColumn;
      return { ...line, content };
    }
    return { ...line, content: line.content.slice(0, MAX_LINE_WIDTH - 3) + '...' };
  });
  return { processedLines, displayColumn };
}

/** Color a snippet output line based on content */
function colorSnippetLine(line: string, severity: string): string {
  if (line.includes(BOX.DOT)) {
    const colored = severity === 'error'
      ? line.replace(new RegExp(BOX.HORIZONTAL, 'g'), pc.red(BOX.HORIZONTAL))
      : line.replace(new RegExp(BOX.HORIZONTAL, 'g'), pc.yellow(BOX.HORIZONTAL));
    return `  ${pc.dim(colored.replace(BOX.DOT, pc.cyan(BOX.DOT)))}`;
  }
  const parts = line.split(BOX.VERTICAL);
  if (parts.length >= 2) {
    return `  ${pc.dim(parts[0] + BOX.VERTICAL)}${parts.slice(1).join(BOX.VERTICAL)}`;
  }
  return `  ${line}`;
}

/** Format help section for diagnostic */
function formatHelpSection(diagnostic: Diagnostic): string | null {
  if (diagnostic.suggestion) {
    return `${pc.cyan(pc.bold('help'))}: ${diagnostic.suggestion}`;
  }
  if (diagnostic.help) {
    const helpText = diagnostic.help.length > 100 ? diagnostic.help.slice(0, 97) + '...' : diagnostic.help;
    return `${pc.cyan(pc.bold('help'))}: ${helpText}`;
  }
  return null;
}

/**
 * Format a single diagnostic in rich style.
 */
function formatRichDiagnostic(
  diagnostic: Diagnostic,
  sources: Map<string, string>
): string {
  const output: string[] = [formatDiagnosticHeader(diagnostic)];
  const source = sources.get(diagnostic.file);

  if (!source) {
    output.push(`  ${pc.dim(`at ${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`)}`);
    return output.join('\n');
  }

  const snippetLines = extractSnippetLines(source, diagnostic.line, 1, 1);
  if (snippetLines.length === 0) return output.join('\n');

  const maxLineNum = Math.max(...snippetLines.map(l => l.lineNumber));
  const gutterWidth = calculateGutterWidth(maxLineNum);
  const primaryLineIndex = snippetLines.findIndex(l => l.lineNumber === diagnostic.line);
  const underlineLength = inferUnderlineLength(diagnostic, snippetLines[primaryLineIndex]?.content ?? '');
  const { processedLines, displayColumn } = processSnippetLines(snippetLines, diagnostic, underlineLength);

  const fileLocation = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`;
  output.push(`  ${pc.dim(pc.cyan(BOX.TOP_LEFT + BOX.HORIZONTAL))}${pc.dim('[')}${pc.underline(fileLocation)}${pc.dim(']')}`);

  const label = generateLabel(diagnostic);
  const snippetOutput = renderSnippet(
    { lines: processedLines, primaryLineIndex, column: displayColumn, underlineLength, ...(label ? { label: pc.dim(label) } : {}) },
    gutterWidth
  );

  for (const line of snippetOutput) {
    output.push(colorSnippetLine(line, diagnostic.severity));
  }

  output.push(`  ${pc.dim(pc.cyan(BOX.BOTTOM_LEFT + BOX.HORIZONTAL))}`);

  const help = formatHelpSection(diagnostic);
  if (help) output.push(help);

  return output.join('\n');
}

/** Pluralize a word based on count */
function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

/** Format rich issue count */
function formatRichIssueCount(errorCount: number, warningCount: number): string {
  if (errorCount === 0 && warningCount === 0) return pc.green('No issues found.');
  const parts: string[] = [];
  if (warningCount > 0) parts.push(pc.yellow(`${warningCount} ${pluralize(warningCount, 'warning')}`));
  if (errorCount > 0) parts.push(pc.red(`${errorCount} ${pluralize(errorCount, 'error')}`));
  return `Found ${parts.join(' and ')}.`;
}

/**
 * Format the summary line.
 */
function formatRichSummary(result: RichLintResult): string {
  const output = [formatRichIssueCount(result.errorCount, result.warningCount)];
  if (result.timing) {
    const files = `${result.timing.fileCount} ${pluralize(result.timing.fileCount, 'file')}`;
    output.push(pc.dim(`Finished in ${result.timing.durationMs}ms on ${files}.`));
  }
  return output.join('\n');
}
