import type { LineIndex } from './position.js';

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  /** Unique identifier for deduplication and tracking */
  id: string;
  rule: string;
  message: string;
  file: string;
  offset: number;
  line: number;
  column: number;
  severity: Severity;
  fix?: Fix;
  /** Length of the highlighted region in characters (for sentence-level diagnostics) */
  length?: number;
  /** Detailed explanation of why this is flagged */
  help?: string;
  /** Suggested action to resolve the issue */
  suggestion?: string;
  /** AI instruction for fixing this issue */
  prompt?: string;
}

export interface Fix {
  start: number;
  end: number;
  text: string;
}

export interface LintResult {
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  fixCount: number;
}

export interface RichLintResult extends LintResult {
  /** Map of file path to source content for rich formatting */
  sources: Map<string, string>;
  /** Timing information for summary display */
  timing?: {
    durationMs: number;
    fileCount: number;
  };
}

export interface TextSpan {
  text: string;
  offset: number;
}

export type Rule = (spans: TextSpan[], file: string, lineIndex: LineIndex) => Diagnostic[];
