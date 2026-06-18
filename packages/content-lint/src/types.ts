/**
 * @volo/content-lint - Type Definitions
 *
 * Browser-safe types for markdown linting (accessibility + structural rules).
 */

// --- Severity & Diagnostic Types ---

export type Severity = "error" | "warning";

export interface Fix {
  start: number;
  end: number;
  text: string;
}

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
}

// --- Line Index Types ---

/**
 * Pre-computed line offsets for fast offset-to-position lookups.
 * Call createLineIndex once per file, then use offsetToPositionFast for O(log n) lookups.
 */
export interface LineIndex {
  lineStarts: number[];
}

// --- A11y Rule Types ---

/** A11y (accessibility) rule names */
export const A11Y_RULE_NAMES = [
  "altText",
  "headingHierarchy",
  "headingDuplicate",
  "linkText",
  "codeBlockLanguage",
  "embedTitle",
] as const;

export type A11yRuleName = (typeof A11Y_RULE_NAMES)[number];

// --- Structural Rule Types ---

/** Structural markdown rule names */
export const STRUCTURAL_RULE_NAMES = [
  "noEmptyUrl",
  "noUndefinedReferences",
  "noEmphasisAsHeading",
  "noHeadingPunctuation",
  "noShellDollars",
] as const;

export type StructuralRuleName = (typeof STRUCTURAL_RULE_NAMES)[number];

// --- Combined Types ---

/** All lint rule names (a11y + structural) */
export const LINT_RULE_NAMES = [...A11Y_RULE_NAMES, ...STRUCTURAL_RULE_NAMES] as const;

export type LintRuleName = A11yRuleName | StructuralRuleName;

/** Rule category for UI color-coding */
export type RuleCategory = "a11y" | "structural";

/** Map of rule names to their categories */
export const RULE_CATEGORIES: Record<LintRuleName, RuleCategory> = {
  // A11y rules
  altText: "a11y",
  headingHierarchy: "a11y",
  headingDuplicate: "a11y",
  linkText: "a11y",
  codeBlockLanguage: "a11y",
  embedTitle: "a11y",
  // Structural rules
  noEmptyUrl: "structural",
  noUndefinedReferences: "structural",
  noEmphasisAsHeading: "structural",
  noHeadingPunctuation: "structural",
  noShellDollars: "structural",
};

// --- Options Types ---

/** Options for a11y checks (backwards compatible) */
export interface A11yOptions {
  skipAltText?: boolean;
  skipHeadings?: boolean;
  skipLinks?: boolean;
  skipCodeBlocks?: boolean;
  skipEmbeds?: boolean;
  severities?: Partial<Record<A11yRuleName, "off" | "warn" | "error">>;
}

/** Options for all lint checks */
export interface LintOptions {
  // Skip entire categories
  skipA11y?: boolean;
  skipStructural?: boolean;
  // Individual a11y skips (backwards compatible)
  skipAltText?: boolean;
  skipHeadings?: boolean;
  skipLinks?: boolean;
  skipCodeBlocks?: boolean;
  skipEmbeds?: boolean;
  // Severity overrides for all rules
  severities?: Partial<Record<LintRuleName, "off" | "warn" | "error">>;
}
