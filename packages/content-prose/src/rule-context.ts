/**
 * Shared execution context and regex helpers for built-in prose rules.
 *
 * Extracted from rules.ts so that rule modules (rules.ts, ste.ts) can share the
 * context without importing each other — rules.ts owns the registry and would
 * otherwise form an import cycle with the rule modules it registers.
 */
import type { Diagnostic } from "./types.js";
import { offsetToPositionFast, type LineIndex } from "./position.js";
import { getHelpForRule } from "./help.js";

/** Escape a literal string for safe use inside a RegExp. */
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Apply the capitalization of `original` to `replacement`.
 * ALL CAPS stays ALL CAPS; a leading capital stays capitalized; otherwise unchanged.
 */
export const preserveCase = (original: string, replacement: string): string => {
  const oFirst = original[0],
    rFirst = replacement[0];
  if (!original || !replacement || oFirst === undefined || rFirst === undefined) return replacement;
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  return oFirst === oFirst.toUpperCase()
    ? rFirst.toUpperCase() + replacement.slice(1)
    : replacement;
};

/** Core execution context shared by all rule implementations. */
export class RuleContext {
  constructor(
    readonly file: string,
    readonly lineIndex: LineIndex,
    readonly severity: Diagnostic["severity"] = "warning",
  ) {}

  diag(
    rule: string,
    offset: number,
    message: string,
    matchText: string,
    extra?: Partial<Pick<Diagnostic, "length" | "fix" | "help" | "suggestion" | "prompt">>,
  ): Diagnostic {
    const { line, column } = offsetToPositionFast(this.lineIndex, offset);
    const id = `${rule}-${offset}-${matchText
      .slice(0, 20)
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "")}`;
    return {
      id,
      rule,
      message,
      file: this.file,
      offset,
      line,
      column,
      severity: this.severity,
      ...extra,
    };
  }

  *scan(text: string, pattern: RegExp, baseOffset = 0) {
    pattern.lastIndex = 0;
    for (let m; (m = pattern.exec(text)); ) {
      if (!m[0].length) {
        pattern.lastIndex++;
        continue;
      }
      yield { text: m[0], groups: m.slice(1), offset: baseOffset + m.index, index: m.index };
    }
  }

  withHelp(rule: string, match: string, extra?: Partial<Diagnostic>): Partial<Diagnostic> {
    const h = getHelpForRule(rule, match);
    return {
      ...extra,
      ...(h?.help === undefined ? {} : { help: h.help }),
      ...(h?.suggestion === undefined ? {} : { suggestion: h.suggestion }),
      ...(h?.prompt === undefined ? {} : { prompt: h.prompt }),
    };
  }
}
