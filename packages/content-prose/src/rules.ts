/**
 * Built-in Prose Rules - OOP + FP refactoring with RuleContext class and declarative registry.
 */
import type { Rule, Diagnostic } from './types.js';
import { offsetToPositionFast, type LineIndex } from './position.js';
import type { RuleName } from './config.js';
import { cuss } from 'cuss';
import { fillers as fillersList } from 'fillers';
import { hedges as hedgesList } from 'hedges';
import { weasels as weaselsList } from 'weasels';
// @ts-expect-error - no-cliches has no types
import noCliches from 'no-cliches';
import { getHelpForRule } from './help.js';
import { tokenizeSentences, calculateARI } from './sentence-tokenizer.js';
import { getSpellCheckerSync } from './spelling.js';

// Word Lists & Pattern Utilities
const fillersWords = fillersList as string[], hedgesWords = hedgesList as string[], weaselsWords = weaselsList as string[];
const cussWords = cuss as Record<string, number>;
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordListPattern = (words: string[]): RegExp => new RegExp(`\\b(${words.map(escapeRegex).join('|')})\\b`, 'gi');

// Data Maps
const SIMPLIFY_MAP: Record<string, string> = {
  utilize: 'use', utilizes: 'uses', utilized: 'used', utilizing: 'using',
  leverage: 'use', leverages: 'uses', leveraged: 'used', leveraging: 'using',
  facilitate: 'help', facilitates: 'helps', facilitated: 'helped', facilitating: 'helping',
  commence: 'start', commences: 'starts', commenced: 'started', commencing: 'starting',
  terminate: 'end', terminates: 'ends', terminated: 'ended', terminating: 'ending',
};
const PROFANITY_SET = new Set(Object.entries(cussWords).filter(([, s]) => s >= 1).map(([w]) => w.toLowerCase()));
const ADVERB_EXCEPTIONS = new Set(['only', 'early', 'daily', 'likely', 'lonely', 'ugly', 'holy', 'rely', 'apply', 'reply', 'supply', 'fly', 'july', 'family', 'friendly', 'lovely', 'silly', 'belly', 'jelly', 'bully']);

// Pre-compiled Patterns
const P = {
  fillers: wordListPattern(fillersWords), weasels: wordListPattern(weaselsWords), hedges: wordListPattern(hedgesWords),
  condescending: wordListPattern(['simply', 'obviously', 'clearly', 'easily', 'of course']),
  repeated: /\b(\w+)\s+\1\b/gi, simplify: wordListPattern(Object.keys(SIMPLIFY_MAP)), word: /\b\w+\b/gi,
  passive: /\b((?:am|are|were|being|is|been|was|be)\s+(?:\w+ed|built|made|done|given|taken|seen|known|found|told|shown|written|broken|chosen|spoken|stolen|driven|forgotten|hidden|begun|sung|run|gone|sent|spent|lent|lost|left|kept|felt|held|met|paid|said|sold|read|heard|thought|bought|brought|caught|taught|fought|sought|worn|torn))\b/gi,
  adverbs: /\b(\w+ly)\b/gi, spelling: /\b([a-zA-Z]+(?:'[a-zA-Z]+)?)\b/g,
} as const;

// RuleContext - Core class for all rule execution
class RuleContext {
  constructor(readonly file: string, readonly lineIndex: LineIndex, readonly severity: Diagnostic['severity'] = 'warning') {}

  diag(rule: string, offset: number, message: string, matchText: string, extra?: Partial<Pick<Diagnostic, 'length' | 'fix' | 'help' | 'suggestion' | 'prompt'>>): Diagnostic {
    const { line, column } = offsetToPositionFast(this.lineIndex, offset);
    const id = `${rule}-${offset}-${matchText.slice(0, 20).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`;
    return { id, rule, message, file: this.file, offset, line, column, severity: this.severity, ...extra };
  }

  *scan(text: string, pattern: RegExp, baseOffset = 0) {
    pattern.lastIndex = 0;
    for (let m; (m = pattern.exec(text)); ) {
      if (!m[0].length) { pattern.lastIndex++; continue; }
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

// Fix Helpers
const getRemovalRange = (spanText: string, i: number, len: number, off: number) => {
  const e = i + len;
  const [s, end] = spanText[e] === ' ' ? [i, e + 1] : (i > 0 && spanText[i - 1] === ' ') ? [i - 1, e] : [i, e];
  return { start: off + s, end: off + end };
};

const preserveCase = (o: string, r: string): string => {
  const oFirst = o[0], rFirst = r[0];
  if (!o || !r || oFirst === undefined || rFirst === undefined) return r;
  if (o === o.toUpperCase()) return r.toUpperCase();
  return oFirst === oFirst.toUpperCase() ? rFirst.toUpperCase() + r.slice(1) : r;
};

// Rule Factory - Pattern-based rule with optional removal fix
const patternRule = (name: string, pat: RegExp, msg: (w: string) => string, sev: Diagnostic['severity'] = 'warning', remove = false): Rule =>
  (spans, file, lineIndex) => {
    const ctx = new RuleContext(file, lineIndex, sev);
    return spans.flatMap(span => [...ctx.scan(span.text, pat, span.offset)].map(m => {
      const fix = remove ? { ...getRemovalRange(span.text, m.index, m.text.length, span.offset), text: '' } : undefined;
      return ctx.diag(name, m.offset, msg(m.text), m.text, ctx.withHelp(name, m.text, fix === undefined ? {} : { fix }));
    }));
  };

// Simple Pattern Rules
export const fillers: Rule = patternRule('fillers', P.fillers, w => `"${w}" is a filler word`, 'warning', true);
export const weasel: Rule = patternRule('weasel', P.weasels, w => `"${w}" is a weasel word`);
export const hedge: Rule = patternRule('hedge', P.hedges, w => `"${w}" is hedging language`);
export const condescending: Rule = patternRule('condescending', P.condescending, w => `"${w}" can be condescending`, 'warning', true);
export const passive: Rule = patternRule('passive', P.passive, w => `"${w}" may be passive voice`);

// Custom Pattern Rules
export const repeated: Rule = (spans, file, lineIndex) => {
  const ctx = new RuleContext(file, lineIndex, 'error');
  return spans.flatMap(span => [...ctx.scan(span.text, P.repeated, span.offset)].flatMap(m => {
    const word = m.groups[0];
    if (word === undefined) return [];
    return [ctx.diag('repeated', m.offset, `"${word}" is repeated`, word, ctx.withHelp('repeated', word, {
      fix: { start: m.offset, end: m.offset + m.text.length, text: word },
    }))];
  }));
};

export const simplify: Rule = (spans, file, lineIndex) => {
  const ctx = new RuleContext(file, lineIndex, 'warning');
  return spans.flatMap(span => [...ctx.scan(span.text, P.simplify, span.offset)].flatMap(m => {
    const replacement = SIMPLIFY_MAP[m.text.toLowerCase()];
    if (replacement === undefined) return [];
    const r = preserveCase(m.text, replacement);
    return [ctx.diag('simplify', m.offset, `"${m.text}" can be simplified to "${r}"`, m.text, ctx.withHelp('simplify', m.text, {
      fix: { start: m.offset, end: m.offset + m.text.length, text: r },
    }))];
  }));
};

export const profanity: Rule = (spans, file, lineIndex) => {
  const ctx = new RuleContext(file, lineIndex, 'error');
  return spans.flatMap(span => [...ctx.scan(span.text, P.word, span.offset)]
    .filter(m => PROFANITY_SET.has(m.text.toLowerCase()))
    .map(m => {
      const s = cussWords[m.text.toLowerCase()] || 1;
      return ctx.diag('profanity', m.offset, `"${m.text}" is profane${s === 2 ? ' (severe)' : ''}`, m.text, ctx.withHelp('profanity', m.text));
    }));
};

export const adverbs: Rule = (spans, file, lineIndex) => {
  const ctx = new RuleContext(file, lineIndex, 'warning');
  return spans.flatMap(span => [...ctx.scan(span.text, P.adverbs, span.offset)]
    .filter(m => !ADVERB_EXCEPTIONS.has(m.text.toLowerCase()))
    .map(m => ctx.diag('adverbs', m.offset, `"${m.text}" is an adverb`, m.text, ctx.withHelp('adverbs', m.text))));
};

export const cliches: Rule = (spans, file, lineIndex) => {
  const ctx = new RuleContext(file, lineIndex, 'warning');
  return spans.flatMap(span => (noCliches(span.text) as Array<{ index: number; offset: number }>).map(m => {
    const txt = span.text.slice(m.index, m.index + m.offset), off = span.offset + m.index;
    return ctx.diag('cliches', off, `"${txt}" is a cliche`, txt, ctx.withHelp('cliches', txt));
  }));
};

// Thresholds for readability analysis
/** Minimum word count for a sentence to be analyzed for readability */
const READABILITY_MIN_WORDS = 14;
/** Maximum ARI score for normal readability (above this is "hard to read") */
const READABILITY_HARD_THRESHOLD = 9;
/** Maximum ARI score for hard readability (above this is "very hard to read") */
const READABILITY_VERY_HARD_THRESHOLD = 16;

// Complex Rules - Readability & Spelling
export const readability: Rule = (spans, file, lineIndex) => {
  const ctx = new RuleContext(file, lineIndex, 'warning');
  return spans.flatMap(span => tokenizeSentences(span.text, span.offset).filter(s => s.wordCount > READABILITY_MIN_WORDS).flatMap(s => {
    const score = calculateARI(s);
    if (score <= READABILITY_HARD_THRESHOLD) return [];
    const hard = score > READABILITY_VERY_HARD_THRESHOLD;
    const msg = hard
      ? `This sentence is very hard to read (${s.wordCount} words, grade ${Math.round(score)}). Consider breaking it up.`
      : `This sentence may be hard to read (${s.wordCount} words, grade ${Math.round(score)}). Consider simplifying.`;
    return [ctx.diag('readability', s.offset, msg, s.text, ctx.withHelp('readability', s.text, { length: s.text.length }))];
  }));
};

/** Flag to track if we've already warned about spell checker unavailability */
let spellCheckerWarningShown = false;

export const spelling: Rule = (spans, file, lineIndex) => {
  const ctx = new RuleContext(file, lineIndex, 'error');
  const checker = getSpellCheckerSync();
  if (!checker) {
    // Warn once about spell checker not being initialized (consistent with other error handling)
    if (!spellCheckerWarningShown) {
      console.warn(
        'Spell checker not initialized. Call getSpellChecker() before linting to enable spelling checks.'
      );
      spellCheckerWarningShown = true;
    }
    return [];
  }

  return spans.flatMap(span => {
    const matches = [...ctx.scan(span.text, P.spelling, span.offset)];

    return matches
      .filter(m => !checker.shouldSkip(m.text) && !checker.check(m.text))
      .map(m => {
        const msg = `"${m.text}" may be misspelled`;
        return ctx.diag('spelling', m.offset, msg, m.text, ctx.withHelp('spelling', m.text));
      });
  });
};

// Exports - Backwards Compatible
export const ruleRegistry: Record<RuleName, Rule> = { fillers, weasel, hedge, condescending, repeated, simplify, profanity, passive, adverbs, cliches, readability, spelling };
/** @deprecated Use ruleRegistry for config-aware linting. */
export const rules: Rule[] = Object.values(ruleRegistry);
