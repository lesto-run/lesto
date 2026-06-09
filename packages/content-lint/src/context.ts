/**
 * Shared Lint Context
 *
 * Provides diagnostic creation and regex scanning utilities for all lint rules.
 */

import type { Diagnostic, Severity, LineIndex, LintRuleName, Fix } from "./types.js";
import { offsetToPositionFast } from "./position.js";

/**
 * Shared context for all lint rules.
 * Provides diagnostic creation and regex scanning utilities.
 */
export class LintContext {
  constructor(
    readonly file: string,
    readonly lineIndex: LineIndex,
  ) {}

  /**
   * Create a diagnostic with auto-calculated positions.
   */
  diag(
    rule: LintRuleName,
    offset: number,
    length: number,
    message: string,
    severity: Severity,
    help?: string,
    fix?: Fix,
  ): Diagnostic {
    const { line, column } = offsetToPositionFast(this.lineIndex, offset);
    // Use deterministic ID format: rule-offset-length
    // This is stable across message changes (e.g., i18n) and suitable for suppression comments
    const id = `${rule}-${offset}-${length}`;
    return {
      id,
      rule,
      message,
      file: this.file,
      offset,
      line,
      column,
      severity,
      length,
      ...(help === undefined ? {} : { help }),
      ...(fix === undefined ? {} : { fix }),
    };
  }

  /**
   * Generator for pattern matching with position tracking.
   */
  *scan(
    content: string,
    pattern: RegExp,
  ): Generator<{ match: RegExpExecArray; offset: number; length: number }> {
    pattern.lastIndex = 0;
    for (let m; (m = pattern.exec(content)); ) {
      if (!m[0].length) {
        pattern.lastIndex++;
        continue;
      }
      yield { match: m, offset: m.index, length: m[0].length };
    }
  }
}
