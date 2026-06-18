/**
 * @lesto/content-prose - Prose Linting SDK
 *
 * This module exports pure functions for linting markdown/prose content.
 * No file I/O or Node.js-specific dependencies - works in any JavaScript environment.
 *
 * For SEO analysis, use @lesto/content-seo
 * For accessibility linting, use @lesto/content-lint
 * For CLI operations, use @lesto/content-cli
 */

import { extract } from "./extract.js";
import { ruleRegistry } from "./rules.js";
import { createLineIndex, offsetToPositionFast } from "./position.js";
import { resolveConfig, type LumenConfig, type ResolvedConfig, type RuleName } from "./config.js";
import type { Diagnostic, Fix } from "./types.js";
import type { CustomRule } from "./custom-rules.js";
import {
  runBanRule,
  runReplaceRule,
  runLimitRule,
  runConsistentRule,
  runFirstUseRule,
  runCasingRule,
  runMatchRule,
  runCustomFunctionRule,
} from "./custom-rule-runner.js";
import type { TextSpan } from "./types.js";
import type { LineIndex } from "./position.js";

/**
 * Registry of sync custom rule runners.
 * Maps rule type to its runner function.
 * Note: Runners are typed to accept specific rule types but are stored as generic handlers.
 * The dispatch functions ensure correct rule types are passed based on rule.type.
 */
type SyncRuleRunner = (
  rule: CustomRule,
  spans: TextSpan[],
  file: string,
  lineIndex: LineIndex,
) => Diagnostic[];

const SYNC_RULE_RUNNERS: Record<string, SyncRuleRunner> = {
  ban: runBanRule as SyncRuleRunner,
  replace: runReplaceRule as SyncRuleRunner,
  limit: runLimitRule as SyncRuleRunner,
  consistent: runConsistentRule as SyncRuleRunner,
  firstUse: runFirstUseRule as SyncRuleRunner,
  casing: runCasingRule as SyncRuleRunner,
  match: runMatchRule as SyncRuleRunner,
};

/**
 * Registry of async custom rule runners (includes sync + custom function).
 */
type AsyncRuleRunner = (
  rule: CustomRule,
  spans: TextSpan[],
  file: string,
  lineIndex: LineIndex,
  basePath?: string,
) => Diagnostic[] | Promise<Diagnostic[]>;

const ASYNC_RULE_RUNNERS: Record<string, AsyncRuleRunner> = {
  ...SYNC_RULE_RUNNERS,
  custom: runCustomFunctionRule as AsyncRuleRunner,
};

/** Dispatch a custom rule to its runner (sync version). Returns empty for async-only rules. */
function dispatchCustomRule(
  rule: CustomRule,
  spans: TextSpan[],
  file: string,
  lineIndex: LineIndex,
): Diagnostic[] {
  const runner = SYNC_RULE_RUNNERS[rule.type];
  return runner ? runner(rule, spans, file, lineIndex) : [];
}

/** Dispatch a custom rule to its runner (async version). Handles all rule types. */
async function dispatchCustomRuleAsync(
  rule: CustomRule,
  spans: TextSpan[],
  file: string,
  lineIndex: LineIndex,
  basePath?: string,
): Promise<Diagnostic[]> {
  const runner = ASYNC_RULE_RUNNERS[rule.type];
  return runner ? runner(rule, spans, file, lineIndex, basePath) : [];
}

// Re-export building blocks for custom linting pipelines
export { extract } from "./extract.js";
export { rules, ruleRegistry } from "./rules.js";
export { createLineIndex } from "./position.js";
export { format } from "./format.js";
export {
  resolveConfig,
  RULE_NAMES,
  DEFAULT_SEVERITIES,
  A11Y_RULE_NAMES,
  A11Y_DEFAULT_SEVERITIES,
  normalizeSeverity,
} from "./config.js";
export { tokenizeSentences, calculateARI } from "./sentence-tokenizer.js";
export { getHelpForRule, RULE_HELP } from "./help.js";
// Note: Spelling functions use dynamic imports for Node.js compatibility.
// They are exported but should only be used in Node.js environments.
// For browser usage, use shouldSkipWord only or pass dictionaryData to createSpellChecker.
export {
  createSpellChecker,
  getSpellChecker,
  getSpellCheckerSync,
  resetSpellChecker,
  shouldSkipWord,
  prewarmSpellChecker,
} from "./spelling.js";
export { TECH_DICTIONARY, getTechDictionary } from "./tech-dictionary.js";
export type {
  Diagnostic,
  LintResult,
  RichLintResult,
  Severity,
  TextSpan,
  Fix,
  Rule,
} from "./types.js";
export type { LineIndex } from "./position.js";
export type {
  LumenConfig,
  ResolvedConfig,
  RuleName,
  RuleSeverity,
  A11yRuleName,
} from "./config.js";
export type { Sentence } from "./sentence-tokenizer.js";
export type { RuleHelp } from "./help.js";
export type { SpellChecker, SpellCheckerOptions } from "./spelling.js";
export type {
  ContentTarget,
  FixAction,
  RemoveFixAction,
  ReplaceFixAction,
  SuggestFixAction,
  TransformFixAction,
  CustomRuleBase,
  BanRule,
  ReplaceRule,
  LimitRule,
  ConsistentRule,
  FirstUseRule,
  CasingRule,
  MatchRule,
  CustomFunctionRule,
  CustomRule,
  CustomRulesConfig,
} from "./custom-rules.js";
export {
  isBanRule,
  isReplaceRule,
  isLimitRule,
  isConsistentRule,
  isFirstUseRule,
  isCasingRule,
  isMatchRule,
  isCustomFunctionRule,
} from "./custom-rules.js";
export {
  runLimitRule,
  runConsistentRule,
  runFirstUseRule,
  runCasingRule,
  runBanRule,
  runReplaceRule,
  runMatchRule,
  runCustomFunctionRule,
  clearCustomFunctionCache,
} from "./custom-rule-runner.js";

/**
 * Options for lintContent function.
 */
export interface LintOptions {
  /** User config (partial) - will be resolved internally */
  config?: LumenConfig;
  /** Pre-resolved config - used as-is, skips resolution step */
  resolvedConfig?: ResolvedConfig;
}

/**
 * Lint content directly without file I/O.
 * Primary API for integrations (editors, CI, etc.)
 *
 * Note: This function only runs prose rules. For accessibility linting,
 * use @lesto/content-lint. For SEO analysis, use @lesto/content-seo.
 *
 * @param content - The markdown/prose content to lint
 * @param file - Optional file path for diagnostic messages (defaults to empty string)
 * @param options - Optional config options for rule severity customization
 * @returns Array of diagnostics found in the content
 */
export function lintContent(content: string, file = "", options: LintOptions = {}): Diagnostic[] {
  // Handle empty/invalid input gracefully
  if (!content || typeof content !== "string") {
    return [];
  }
  const spans = extract(content);
  return lintSpans(content, spans, file, options);
}

/**
 * Options for linting with pre-extracted spans.
 */
export interface LintSpansOptions extends LintOptions {
  /** Pre-computed line index (for performance) */
  lineIndex?: ReturnType<typeof createLineIndex>;
}

/**
 * Lint pre-extracted text spans.
 * Use this when you've already parsed the content (e.g., for web workers that can't use remark-parse).
 *
 * Note: This function only runs prose rules. For accessibility linting,
 * use @lesto/content-lint. For SEO analysis, use @lesto/content-seo.
 *
 * @param content - The original content (needed for line index and disable comments)
 * @param spans - Pre-extracted text spans from extract()
 * @param file - Optional file path for diagnostic messages
 * @param options - Optional config options
 * @returns Array of diagnostics
 */
export function lintSpans(
  content: string,
  spans: TextSpan[],
  file = "",
  options: LintSpansOptions = {},
): Diagnostic[] {
  const lineIndex = options.lineIndex ?? createLineIndex(content);
  const diagnostics: Diagnostic[] = [];

  // Use pre-resolved config if provided, otherwise resolve from user config
  const resolved = options.resolvedConfig ?? resolveConfig(options.config ?? null);

  // Run built-in prose rules
  for (const [ruleName, ruleCheck] of Object.entries(ruleRegistry)) {
    const severity = resolved.rules[ruleName as RuleName];
    if (severity === "off") continue;

    const ruleDiagnostics = ruleCheck(spans, file, lineIndex);

    // Override severity based on config
    for (const d of ruleDiagnostics) {
      d.severity = severity === "error" ? "error" : "warning";
    }
    diagnostics.push(...ruleDiagnostics);
  }

  // Run custom rules (sync only - CustomFunctionRule needs lintContentAsync)
  for (const rule of resolved.customRules) {
    diagnostics.push(...dispatchCustomRule(rule, spans, file, lineIndex));
  }

  return filterDisabled(content, diagnostics);
}

/**
 * Async options for lintContentAsync function.
 */
export interface AsyncLintOptions extends LintOptions {
  /** Base path for resolving relative custom function paths (e.g., import.meta.url) */
  basePath?: string;
}

/**
 * Lint content with support for async custom function rules.
 * Use this when your config includes CustomFunctionRule entries that need
 * to dynamically import external modules.
 *
 * Note: This function only runs prose rules. For accessibility linting,
 * use @lesto/content-lint. For SEO analysis, use @lesto/content-seo.
 *
 * @param content - The markdown/prose content to lint
 * @param file - Optional file path for diagnostic messages (defaults to empty string)
 * @param options - Optional config and async options
 * @returns Promise of array of diagnostics found in the content
 */
export async function lintContentAsync(
  content: string,
  file = "",
  options: AsyncLintOptions = {},
): Promise<Diagnostic[]> {
  // Handle empty/invalid input gracefully
  if (!content || typeof content !== "string") {
    return [];
  }
  const spans = extract(content);
  const lineIndex = createLineIndex(content);
  const diagnostics: Diagnostic[] = [];

  // Use pre-resolved config if provided, otherwise resolve from user config
  const resolved = options.resolvedConfig ?? resolveConfig(options.config ?? null);

  // Run built-in prose rules
  for (const [ruleName, ruleCheck] of Object.entries(ruleRegistry)) {
    const severity = resolved.rules[ruleName as RuleName];
    if (severity === "off") continue;

    const ruleDiagnostics = ruleCheck(spans, file, lineIndex);

    // Override severity based on config
    for (const d of ruleDiagnostics) {
      d.severity = severity === "error" ? "error" : "warning";
    }
    diagnostics.push(...ruleDiagnostics);
  }

  // Run custom rules including async CustomFunctionRule (parallel execution)
  const customResults = await Promise.all(
    resolved.customRules.map((rule) =>
      dispatchCustomRuleAsync(rule, spans, file, lineIndex, options.basePath),
    ),
  );
  for (const result of customResults) {
    diagnostics.push(...result);
  }

  return filterDisabled(content, diagnostics);
}

/**
 * Apply fixes to content string.
 * Fixes are applied in reverse order (highest offset first) to preserve offsets.
 * Overlapping fixes are skipped to prevent corrupted output.
 *
 * Algorithm: Sort fixes by start position descending and apply from end to start.
 * Track the start position of the last applied fix. Skip any fix whose end
 * exceeds this boundary, as it would overlap with already-modified content.
 * This correctly handles all overlap cases because:
 * - Fixes starting after lastStart are impossible (we process in descending order)
 * - Fixes ending after lastStart would overlap (caught by our check)
 *
 * @param content - The original content
 * @param fixes - Array of fixes to apply
 * @returns The content with fixes applied
 */
export function applyFixes(content: string, fixes: Fix[]): string {
  if (!fixes.length) return content;

  // Sort by start position descending (apply from end to start)
  const sorted = [...fixes].toSorted((a, b) => b.start - a.start);

  return sorted.reduce(
    (acc, fix) => {
      // Skip fixes that overlap with already-applied fixes
      if (fix.end > acc.lastStart) return acc;
      return {
        content: acc.content.slice(0, fix.start) + fix.text + acc.content.slice(fix.end),
        lastStart: fix.start,
      };
    },
    { content, lastStart: Infinity },
  ).content;
}

interface DisableNextLine {
  line: number;
  rules: string[]; // Empty array means disable all rules
}

function parseDisableNextLine(content: string): DisableNextLine[] {
  const disables: DisableNextLine[] = [];
  const lines = content.split("\n");
  // Match lumen-disable-next-line or prose-disable-next-line with optional comma-separated rules
  // Supports both kebab-case (fillers) and camelCase (altText) rule names
  const re =
    /<!--\s*(?:lumen|prose)-disable-next-line(?:\s+([a-zA-Z-]+(?:\s*,\s*[a-zA-Z-]+)*))?\s*-->/;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText === undefined) continue;
    const match = re.exec(lineText);
    if (match) {
      const rulesStr = match[1];
      // Preserve original case - comparison will be case-insensitive
      const rules = rulesStr ? rulesStr.split(",").map((r) => r.trim()) : [];
      disables.push({ line: i + 1, rules });
    }
  }

  return disables;
}

/**
 * Filter out diagnostics that are within lumen-disable/lumen-enable comment blocks
 * or on lines immediately following lumen-disable-next-line comments.
 * Also supports prose-disable/prose-enable for the new naming.
 *
 * @param content - The original content
 * @param diagnostics - Array of diagnostics to filter
 * @returns Filtered diagnostics
 */
export function filterDisabled(content: string, diagnostics: Diagnostic[]): Diagnostic[] {
  const disableRe = /<!--\s*(?:lumen|prose)-disable\s*-->/g;
  const enableRe = /<!--\s*(?:lumen|prose)-enable\s*-->/g;

  // Create line index once for O(log n) offset-to-line lookups
  const lineIndex = createLineIndex(content);

  // Build disable ranges using matchAll (immutable pattern)
  const ranges = [...content.matchAll(disableRe)].map((match) => {
    const start = offsetToPositionFast(lineIndex, match.index!).line;
    enableRe.lastIndex = match.index!;
    const enableMatch = enableRe.exec(content);
    const end = enableMatch ? offsetToPositionFast(lineIndex, enableMatch.index).line : Infinity;
    return { start, end };
  });

  const nextLineDisables = parseDisableNextLine(content);

  return diagnostics.filter((d) => {
    // Check if in a disabled range
    const inDisabledRange = ranges.some((r) => d.line >= r.start && d.line <= r.end);
    if (inDisabledRange) return false;

    // Check if on a line following a disable-next-line comment
    // Use case-insensitive comparison to support both kebab-case and camelCase
    const hasNextLineDisable = nextLineDisables.some(
      (disable) =>
        d.line === disable.line + 1 &&
        (disable.rules.length === 0 ||
          disable.rules.some((r) => r.toLowerCase() === d.rule.toLowerCase())),
    );
    return !hasNextLineDisable;
  });
}

/**
 * Create a LintResult summary from diagnostics.
 *
 * @param diagnostics - Array of diagnostics
 * @returns LintResult with counts
 */
export function createLintResult(diagnostics: Diagnostic[]) {
  return {
    diagnostics,
    errorCount: diagnostics.filter((d) => d.severity === "error").length,
    warningCount: diagnostics.filter((d) => d.severity === "warning").length,
    fixCount: diagnostics.filter((d) => d.fix).length,
  };
}
