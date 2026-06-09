/**
 * Custom Rule Types for Vale-level Lint Rules
 *
 * These types define the structure of user-configurable lint rules
 * that can be defined in configuration files.
 */

import type { Severity } from "./types.js";

/**
 * Content targeting - which markdown elements the rule applies to.
 * Use 'text' for all prose content.
 */
export type ContentTarget =
  | "text" // All prose content (default)
  | "heading" // Headings (# through ######)
  | "paragraph" // Regular paragraphs
  | "list" // List items
  | "blockquote" // Blockquotes
  | "code" // Inline code (backticks)
  | "link" // Link text
  | "alt" // Image alt text
  | "title"; // Link/image titles

/**
 * Fix action types for auto-fixing diagnostics.
 */
export type FixAction = RemoveFixAction | ReplaceFixAction | SuggestFixAction | TransformFixAction;

/**
 * Remove matched text entirely.
 */
export interface RemoveFixAction {
  type: "remove";
  /** Optional: also remove surrounding whitespace */
  cleanWhitespace?: boolean;
}

/**
 * Replace matched text with a fixed string.
 */
export interface ReplaceFixAction {
  type: "replace";
  /** The replacement text */
  with: string;
}

/**
 * Suggest replacements without auto-applying.
 * Used when multiple valid replacements exist.
 */
export interface SuggestFixAction {
  type: "suggest";
  /** Ordered list of suggestions (first is preferred) */
  suggestions: string[];
}

/**
 * Transform matched text using a transformation function.
 */
export interface TransformFixAction {
  type: "transform";
  /** Transformation to apply */
  transform: "lowercase" | "uppercase" | "titlecase" | "sentencecase";
}

/**
 * Base interface for all custom rule types.
 */
export interface CustomRuleBase {
  /** Unique rule name (used in diagnostics) */
  name: string;
  /** Human-readable message shown to users */
  message: string;
  /** Severity level */
  severity?: Severity;
  /** Content elements to target */
  in?: ContentTarget[];
  /** Detailed help text explaining why this is flagged */
  help?: string;
  /** Suggestion for how to resolve */
  suggestion?: string;
  /** Whether rule is enabled */
  enabled?: boolean;
}

/**
 * Ban rule: flag and optionally remove specific words/phrases.
 *
 * @example
 * ```yaml
 * - type: ban
 *   name: no-blacklist
 *   message: "Avoid using '$match'"
 *   pattern: ['blacklist', 'whitelist', 'master', 'slave']
 *   fix: { type: 'remove', cleanWhitespace: true }
 * ```
 */
export interface BanRule extends CustomRuleBase {
  type: "ban";
  /** Words or patterns to ban (can be strings or regex patterns) */
  pattern: string | string[];
  /** Whether patterns are regex (default: false, uses word boundaries) */
  regex?: boolean;
  /** Case-insensitive matching (default: true) */
  ignoreCase?: boolean;
  /** Fix action when triggered */
  fix?: RemoveFixAction | ReplaceFixAction | SuggestFixAction;
}

/**
 * Replace rule: find and replace specific words/phrases.
 *
 * @example
 * ```yaml
 * - type: replace
 *   name: use-inclusive
 *   message: "Use '$replacement' instead of '$match'"
 *   swap:
 *     blacklist: blocklist
 *     whitelist: allowlist
 * ```
 */
export interface ReplaceRule extends CustomRuleBase {
  type: "replace";
  /** Map of patterns to their replacements */
  swap: Record<string, string>;
  /** Case-insensitive matching (default: true) */
  ignoreCase?: boolean;
  /** Preserve original casing in replacement (default: true) */
  preserveCase?: boolean;
}

/**
 * Limit rule: enforce minimum/maximum occurrences.
 *
 * @example
 * ```yaml
 * - type: limit
 *   name: limit-exclamations
 *   message: "Too many exclamation marks"
 *   pattern: '!'
 *   max: 1
 *   scope: document
 * ```
 */
export interface LimitRule extends CustomRuleBase {
  type: "limit";
  /** Pattern to count */
  pattern: string;
  /** Whether pattern is regex */
  regex?: boolean;
  /** Minimum occurrences (default: 0) */
  min?: number;
  /** Maximum occurrences (default: unlimited) */
  max?: number;
  /** Scope for counting */
  scope?: "sentence" | "paragraph" | "document";
}

/**
 * Consistent rule: ensure consistent usage of alternatives.
 *
 * @example
 * ```yaml
 * - type: consistent
 *   name: consistent-spelling
 *   message: "Use '$preferred' consistently (found '$match')"
 *   either:
 *     - [color, colour]
 *     - [gray, grey]
 *     - [canceled, cancelled]
 * ```
 */
export interface ConsistentRule extends CustomRuleBase {
  type: "consistent";
  /** Groups of interchangeable terms (first seen wins) */
  either: string[][];
  /** Case-insensitive matching (default: true) */
  ignoreCase?: boolean;
}

/**
 * FirstUse rule: require explanation or definition on first use.
 *
 * @example
 * ```yaml
 * - type: firstUse
 *   name: define-acronyms
 *   message: "Define '$match' on first use"
 *   pattern: '[A-Z]{2,}'
 *   requiresExpansion: true
 * ```
 */
export interface FirstUseRule extends CustomRuleBase {
  type: "firstUse";
  /** Pattern to match (usually regex for acronyms) */
  pattern: string;
  /** Whether pattern is regex (default: true for firstUse) */
  regex?: boolean;
  /** Require expansion/definition in parentheses on first use */
  requiresExpansion?: boolean;
  /** Known terms that don't need expansion */
  exceptions?: string[];
}

/**
 * Casing rule: enforce casing conventions.
 *
 * @example
 * ```yaml
 * - type: casing
 *   name: heading-case
 *   message: "Headings should use sentence case"
 *   in: [heading]
 *   case: sentence
 * ```
 */
export interface CasingRule extends CustomRuleBase {
  type: "casing";
  /** Required casing style */
  case: "lower" | "upper" | "title" | "sentence";
  /** Words to ignore (proper nouns, acronyms, etc.) */
  exceptions?: string[];
}

/**
 * Match rule: flag or require patterns.
 *
 * @example
 * ```yaml
 * - type: match
 *   name: no-todo-comments
 *   message: "Unresolved TODO found"
 *   pattern: 'TODO|FIXME|HACK'
 *   regex: true
 * ```
 */
export interface MatchRule extends CustomRuleBase {
  type: "match";
  /** Pattern to match */
  pattern: string;
  /** Whether pattern is regex (default: false) */
  regex?: boolean;
  /** Case-insensitive matching (default: true) */
  ignoreCase?: boolean;
  /** Invert match - flag when pattern is NOT found */
  negate?: boolean;
  /** Fix action when triggered */
  fix?: FixAction;
}

/**
 * Custom rule: use a JavaScript/TypeScript function for complex logic.
 *
 * @example
 * ```yaml
 * - type: custom
 *   name: check-links
 *   message: "Link validation failed"
 *   function: './rules/check-links.js'
 * ```
 */
export interface CustomFunctionRule extends CustomRuleBase {
  type: "custom";
  /** Path to the custom rule function module */
  function: string;
}

/**
 * Union of all custom rule types.
 */
export type CustomRule =
  | BanRule
  | ReplaceRule
  | LimitRule
  | ConsistentRule
  | FirstUseRule
  | CasingRule
  | MatchRule
  | CustomFunctionRule;

/**
 * Type guard for BanRule.
 */
export function isBanRule(rule: CustomRule): rule is BanRule {
  return rule.type === "ban";
}

/**
 * Type guard for ReplaceRule.
 */
export function isReplaceRule(rule: CustomRule): rule is ReplaceRule {
  return rule.type === "replace";
}

/**
 * Type guard for LimitRule.
 */
export function isLimitRule(rule: CustomRule): rule is LimitRule {
  return rule.type === "limit";
}

/**
 * Type guard for ConsistentRule.
 */
export function isConsistentRule(rule: CustomRule): rule is ConsistentRule {
  return rule.type === "consistent";
}

/**
 * Type guard for FirstUseRule.
 */
export function isFirstUseRule(rule: CustomRule): rule is FirstUseRule {
  return rule.type === "firstUse";
}

/**
 * Type guard for CasingRule.
 */
export function isCasingRule(rule: CustomRule): rule is CasingRule {
  return rule.type === "casing";
}

/**
 * Type guard for MatchRule.
 */
export function isMatchRule(rule: CustomRule): rule is MatchRule {
  return rule.type === "match";
}

/**
 * Type guard for CustomFunctionRule.
 */
export function isCustomFunctionRule(rule: CustomRule): rule is CustomFunctionRule {
  return rule.type === "custom";
}

/**
 * Custom rule configuration in lumen config.
 */
export interface CustomRulesConfig {
  /** Array of custom rule definitions */
  customRules?: CustomRule[];
}
