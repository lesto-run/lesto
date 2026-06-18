/**
 * @volo/content-lint - Markdown Linting for Documentation
 *
 * A browser-safe package for checking markdown content for:
 * - Accessibility issues (a11y rules)
 * - Structural consistency (structural rules)
 *
 * @example
 * ```ts
 * import { lint, lintA11y, lintStructural } from "@volo/content-lint";
 *
 * // Run all lint checks (a11y + structural)
 * const diagnostics = lint(markdownContent, "path/to/file.md");
 *
 * // Run only a11y checks (backwards compatible)
 * const a11yDiagnostics = lintA11y(markdownContent, "path/to/file.md");
 *
 * // Run only structural checks
 * const structuralDiagnostics = lintStructural(markdownContent, "path/to/file.md");
 *
 * // Run specific checks
 * import { createLineIndex, checkAltText, checkNoEmptyUrl } from "@volo/content-lint";
 * const lineIndex = createLineIndex(content);
 * const altTextIssues = checkAltText(content, file, lineIndex);
 * const emptyUrlIssues = checkNoEmptyUrl(content, file, lineIndex);
 * ```
 */

// Main linting functions
export { lint, lintA11y, lintStructural } from "./rules.js";

// A11y check functions
export { checkAltText, checkHeadings, checkLinks, checkCodeBlocks, checkEmbeds } from "./rules.js";

// Structural check functions
export {
  checkNoEmptyUrl,
  checkNoUndefinedReferences,
  checkNoEmphasisAsHeading,
  checkNoHeadingPunctuation,
  checkNoShellDollars,
} from "./rules.js";

// Position utilities
export { createLineIndex, offsetToPositionFast } from "./position.js";

// Context class (for custom rules)
export { LintContext } from "./context.js";

// Types
export type {
  Severity,
  Fix,
  Diagnostic,
  LineIndex,
  // A11y types (backwards compatible)
  A11yRuleName,
  A11yOptions,
  // Structural types
  StructuralRuleName,
  // Combined types
  LintRuleName,
  RuleCategory,
  LintOptions,
} from "./types.js";

// Constants
export {
  A11Y_RULE_NAMES,
  STRUCTURAL_RULE_NAMES,
  LINT_RULE_NAMES,
  RULE_CATEGORIES,
} from "./types.js";
