/**
 * Lumen Configuration Types and Resolver
 *
 * This module is browser-safe - no Node.js dependencies.
 * For filesystem operations, use ./config-loader.ts (Node.js only).
 */

import type { CustomRule } from './custom-rules.js';

/** Prose rule names */
export const RULE_NAMES = [
  'fillers',
  'weasel',
  'hedge',
  'condescending',
  'repeated',
  'simplify',
  'profanity',
  'passive',
  'adverbs',
  'cliches',
  'readability',
  'spelling',
] as const;

export type RuleName = (typeof RULE_NAMES)[number];
export type RuleSeverity = 'off' | 'warn' | 'error' | 0 | 1 | 2;

/** A11y (accessibility) rule names */
export const A11Y_RULE_NAMES = [
  'altText',
  'headingHierarchy',
  'headingDuplicate',
  'linkText',
  'codeBlockLanguage',
  'embedTitle',
] as const;

export type A11yRuleName = (typeof A11Y_RULE_NAMES)[number];

/**
 * User-facing config format (partial rules allowed).
 * This is what gets written to .lumenrc.json
 */
export interface LumenConfig {
  rules: Partial<Record<RuleName, RuleSeverity>>;
  /** A11y (accessibility) rules */
  a11y?: Partial<Record<A11yRuleName, RuleSeverity>>;
  /** Custom rules defined by the user */
  customRules?: CustomRule[];
}

/**
 * Resolved config with all rules defined.
 * Used internally by lintContent.
 */
export interface ResolvedConfig {
  rules: Record<RuleName, 'off' | 'warn' | 'error'>;
  /** A11y (accessibility) rules */
  a11y: Record<A11yRuleName, 'off' | 'warn' | 'error'>;
  /** Custom rules ready for execution */
  customRules: CustomRule[];
}

/**
 * Default severity for each prose rule.
 * Most rules are warnings; repeated and profanity are errors.
 */
export const DEFAULT_SEVERITIES: Record<RuleName, 'warn' | 'error'> = {
  fillers: 'warn',
  weasel: 'warn',
  hedge: 'warn',
  condescending: 'warn',
  repeated: 'error',
  simplify: 'warn',
  profanity: 'error',
  passive: 'warn',
  adverbs: 'warn',
  cliches: 'warn',
  readability: 'warn',
  spelling: 'error',
};

/**
 * Default severity for each a11y rule.
 * Critical accessibility issues are errors.
 */
export const A11Y_DEFAULT_SEVERITIES: Record<A11yRuleName, 'warn' | 'error'> = {
  altText: 'error',
  headingHierarchy: 'error',
  headingDuplicate: 'warn',
  linkText: 'warn',
  codeBlockLanguage: 'warn',
  embedTitle: 'error',
};

/**
 * Normalize a severity value to the canonical string form.
 *
 * @param value - User-provided severity (string or number)
 * @param defaultSeverity - Default to use if value is undefined
 * @returns Normalized severity ('off' | 'warn' | 'error')
 */
export function normalizeSeverity(
  value: RuleSeverity | undefined,
  defaultSeverity: 'warn' | 'error'
): 'off' | 'warn' | 'error' {
  if (value === undefined) return defaultSeverity;
  if (value === 0 || value === 'off') return 'off';
  if (value === 1 || value === 'warn') return 'warn';
  if (value === 2 || value === 'error') return 'error';
  // Invalid value - warn and use default
  console.warn(`Invalid severity "${value}", using default "${defaultSeverity}"`);
  return defaultSeverity;
}

/**
 * Resolve a user config (partial) to a full config with all rules defined.
 * Merges user settings with defaults.
 *
 * @param config - User config or null (defaults only)
 * @returns Resolved config with all rules defined
 */
export function resolveConfig(config: LumenConfig | null): ResolvedConfig {
  const rules = {} as Record<RuleName, 'off' | 'warn' | 'error'>;

  for (const ruleName of RULE_NAMES) {
    const userSeverity = config?.rules?.[ruleName];
    rules[ruleName] = normalizeSeverity(userSeverity, DEFAULT_SEVERITIES[ruleName]);
  }

  // Resolve a11y rules
  const a11y = {} as Record<A11yRuleName, 'off' | 'warn' | 'error'>;

  for (const ruleName of A11Y_RULE_NAMES) {
    const userSeverity = config?.a11y?.[ruleName];
    a11y[ruleName] = normalizeSeverity(userSeverity, A11Y_DEFAULT_SEVERITIES[ruleName]);
  }

  // Filter out disabled custom rules
  const customRules = (config?.customRules ?? []).filter(
    (rule) => rule.enabled !== false
  );

  return { rules, a11y, customRules };
}
