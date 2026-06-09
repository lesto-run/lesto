/**
 * Custom Rule Runner
 *
 * Elegant OOP design with a RuleContext class providing shared behavior.
 */

import type { Diagnostic, TextSpan } from "./types.js";
import type { LineIndex } from "./position.js";
import { offsetToPositionFast } from "./position.js";
import { tokenizeSentences } from "./sentence-tokenizer.js";
import type {
  LimitRule,
  ConsistentRule,
  FirstUseRule,
  CasingRule,
  BanRule,
  ReplaceRule,
  MatchRule,
  CustomFunctionRule,
} from "./custom-rules.js";
import type { Rule } from "./types.js";

// ============================================================================
// Core Class - All rule execution flows through this
// ============================================================================

class RuleContext {
  constructor(
    readonly file: string,
    readonly lineIndex: LineIndex,
    readonly severity: Diagnostic["severity"] = "warning",
  ) {}

  /** Create a diagnostic at the given offset */
  diag(
    rule: string,
    offset: number,
    message: string,
    matchText: string,
    extra?: {
      length?: number | undefined;
      fix?: Diagnostic["fix"] | undefined;
      help?: string | undefined;
      suggestion?: string | undefined;
    },
  ): Diagnostic {
    const { line, column } = offsetToPositionFast(this.lineIndex, offset);
    const id = `${rule}-${offset}-${matchText.slice(0, 20).toLowerCase().replace(/\W+/g, "_")}`;
    const diagnostic: Diagnostic = {
      id,
      rule,
      message,
      file: this.file,
      offset,
      line,
      column,
      severity: this.severity,
    };
    if (extra?.length !== undefined) diagnostic.length = extra.length;
    if (extra?.fix !== undefined) diagnostic.fix = extra.fix;
    if (extra?.help !== undefined) diagnostic.help = extra.help;
    if (extra?.suggestion !== undefined) diagnostic.suggestion = extra.suggestion;
    return diagnostic;
  }

  /** Iterate all regex matches in text */
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

  /** Combine spans into single text block */
  static combine(spans: TextSpan[]) {
    return { text: spans.map((s) => s.text).join(" "), offset: spans[0]?.offset ?? 0 };
  }

  /** Split text into units by scope */
  static getUnits(spans: TextSpan[], scope: "document" | "paragraph" | "sentence" = "document") {
    if (scope === "document") return [RuleContext.combine(spans)];
    return spans.flatMap((s) =>
      scope === "paragraph"
        ? RuleContext.splitParagraphs(s.text, s.offset)
        : tokenizeSentences(s.text, s.offset),
    );
  }

  /** Split text into paragraphs */
  private static splitParagraphs(text: string, base: number) {
    const result: Array<{ text: string; offset: number }> = [];
    let lastEnd = 0;
    for (const m of text.matchAll(/\n\s*\n/g)) {
      const raw = text.slice(lastEnd, m.index);
      const para = raw.trim();
      // Calculate offset by finding leading whitespace length
      if (para)
        result.push({ text: para, offset: base + lastEnd + (raw.length - raw.trimStart().length) });
      lastEnd = m.index! + m[0].length;
    }
    const lastRaw = text.slice(lastEnd);
    const last = lastRaw.trim();
    if (last)
      result.push({
        text: last,
        offset: base + lastEnd + (lastRaw.length - lastRaw.trimStart().length),
      });
    return result;
  }
}

// ============================================================================
// Fix Calculator - Handles all fix types
// ============================================================================

type FixDef =
  | { type: "remove"; cleanWhitespace?: boolean }
  | { type: "replace"; with: string }
  | { type: "suggest"; suggestions: string[] }
  | { type: "transform"; transform: string };

function calcFix(
  fix: FixDef | undefined,
  spanText: string,
  matchIdx: number,
  matchText: string,
  spanOffset: number,
): Diagnostic["fix"] {
  if (!fix) return undefined;
  const offset = spanOffset + matchIdx;
  const end = offset + matchText.length;

  switch (fix.type) {
    case "remove": {
      const baseEnd = matchIdx + matchText.length;
      const adjustedRange = fix.cleanWhitespace
        ? spanText[baseEnd] === " "
          ? { s: matchIdx, e: baseEnd + 1 }
          : matchIdx > 0 && spanText[matchIdx - 1] === " "
            ? { s: matchIdx - 1, e: baseEnd }
            : { s: matchIdx, e: baseEnd }
        : { s: matchIdx, e: baseEnd };
      return { start: spanOffset + adjustedRange.s, end: spanOffset + adjustedRange.e, text: "" };
    }
    case "replace":
      return { start: offset, end, text: fix.with };
    case "suggest":
      return fix.suggestions[0] ? { start: offset, end, text: fix.suggestions[0] } : undefined;
    case "transform": {
      const first = matchText[0];
      if (!matchText || first === undefined) return undefined;
      const t = fix.transform;
      const text =
        t === "lowercase"
          ? matchText.toLowerCase()
          : t === "uppercase"
            ? matchText.toUpperCase()
            : first.toUpperCase() + matchText.slice(1).toLowerCase();
      return { start: offset, end, text };
    }
    default:
      return undefined;
  }
}

function preserveCase(orig: string, repl: string): string {
  const origFirst = orig[0],
    replFirst = repl[0];
  if (!orig || !repl || origFirst === undefined || replFirst === undefined) return repl;
  if (orig === orig.toUpperCase()) return repl.toUpperCase();
  if (origFirst === origFirst.toUpperCase()) return replFirst.toUpperCase() + repl.slice(1);
  return repl;
}

// ============================================================================
// Pattern Builder - Creates regex patterns
// ============================================================================

function escapePattern(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(
  pattern: string,
  isRegex: boolean,
  ignoreCase = true,
  wordBound = true,
): RegExp {
  const p = isRegex ? pattern : escapePattern(pattern);
  const flags = ignoreCase ? "gi" : "g";
  return new RegExp(wordBound && !isRegex ? `\\b${p}\\b` : p, flags);
}

function patternFromList(patterns: string[], ignoreCase = true): RegExp {
  const escaped = patterns.map((p) => escapePattern(p));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, ignoreCase ? "gi" : "g");
}

// ============================================================================
// Rule Runners - Clean, focused implementations
// ============================================================================

export function runLimitRule(
  rule: LimitRule,
  spans: TextSpan[],
  file: string,
  lineIndex: LineIndex,
): Diagnostic[] {
  const ctx = new RuleContext(file, lineIndex, rule.severity ?? "warning");
  const { min = 0, max, pattern, help, suggestion } = rule;
  const regex = buildPattern(pattern, rule.regex ?? false, true, false);
  const scope = rule.scope ?? "document";

  // For paragraph/sentence scope, process each unit separately
  if (scope !== "document") {
    return RuleContext.getUnits(spans, scope).flatMap((unit) => {
      const matches = [...ctx.scan(unit.text, regex, unit.offset)];
      const count = matches.length;
      const results: Diagnostic[] = [];

      if (max !== undefined && count > max && matches[max]) {
        const m = matches[max];
        const msg = rule.message
          .replace("$count", String(count))
          .replace("$max", String(max))
          .replace("$match", m.text);
        results.push(ctx.diag(rule.name, m.offset, msg, m.text, { help, suggestion }));
      }

      if (count < min) {
        const msg = rule.message
          .replace("$count", String(count))
          .replace("$min", String(min))
          .replace("$match", pattern);
        results.push(ctx.diag(rule.name, unit.offset, msg, pattern, { help, suggestion }));
      }

      return results;
    });
  }

  // For document scope, iterate spans individually while tracking total count
  // This maintains correct offsets (combining spans loses offset accuracy)
  const allMatches: Array<{ text: string; offset: number }> = [];
  for (const span of spans) {
    for (const m of ctx.scan(span.text, regex, span.offset)) {
      allMatches.push({ text: m.text, offset: m.offset });
    }
  }

  const count = allMatches.length;
  const results: Diagnostic[] = [];

  if (max !== undefined && count > max && allMatches[max]) {
    const m = allMatches[max];
    const msg = rule.message
      .replace("$count", String(count))
      .replace("$max", String(max))
      .replace("$match", m.text);
    results.push(ctx.diag(rule.name, m.offset, msg, m.text, { help, suggestion }));
  }

  if (count < min) {
    const msg = rule.message
      .replace("$count", String(count))
      .replace("$min", String(min))
      .replace("$match", pattern);
    results.push(ctx.diag(rule.name, spans[0]?.offset ?? 0, msg, pattern, { help, suggestion }));
  }

  return results;
}

export function runConsistentRule(
  rule: ConsistentRule,
  spans: TextSpan[],
  file: string,
  lineIndex: LineIndex,
): Diagnostic[] {
  const ctx = new RuleContext(file, lineIndex, rule.severity ?? "warning");
  const ignoreCase = rule.ignoreCase ?? true;
  const norm = (s: string) => (ignoreCase ? s.toLowerCase() : s);
  const firstSeen = new Map<number, string>();

  return rule.either.flatMap((group, gi) => {
    if (!group || group.length < 2) return [];
    const regex = patternFromList(group, ignoreCase);

    // Iterate through spans individually for correct offsets
    // while maintaining document-wide consistency tracking via firstSeen
    return spans.flatMap((span) =>
      [...ctx.scan(span.text, regex, span.offset)].flatMap((m) => {
        const variant = group.find((v) => norm(v) === norm(m.text));
        if (!variant) return [];

        const existing = firstSeen.get(gi);
        if (!existing) {
          firstSeen.set(gi, variant);
          return [];
        }
        if (norm(existing) === norm(variant)) return [];

        const msg = rule.message.replace("$preferred", existing).replace("$match", m.text);
        return [
          ctx.diag(rule.name, m.offset, msg, m.text, {
            fix: { start: m.offset, end: m.offset + m.text.length, text: existing },
            help: rule.help,
            suggestion: rule.suggestion,
          }),
        ];
      }),
    );
  });
}

export function runFirstUseRule(
  rule: FirstUseRule,
  spans: TextSpan[],
  file: string,
  lineIndex: LineIndex,
): Diagnostic[] {
  const ctx = new RuleContext(file, lineIndex, rule.severity ?? "warning");
  const exceptions = new Set(rule.exceptions?.map((e) => e.toLowerCase()) ?? []);
  const seen = new Set<string>();
  const needsExpansion = rule.requiresExpansion ?? true;

  const isRegex = rule.regex ?? true;
  const patternStr = isRegex ? rule.pattern : `\\b${escapePattern(rule.pattern)}\\b`;
  const regex = new RegExp(patternStr, "g");

  // Iterate through each span individually to maintain correct document offsets
  // (combining spans loses offset accuracy when spans are non-contiguous)
  return spans.flatMap((span) => {
    const hasExpansion = (idx: number, len: number) =>
      /^\s*\([^)]+\)/.test(span.text.slice(idx + len)) ||
      /\([^)]+\)\s*$/.test(span.text.slice(0, idx));

    return [...ctx.scan(span.text, regex, span.offset)].flatMap((m) => {
      const normalized = m.text.toLowerCase();
      if (exceptions.has(normalized) || seen.has(normalized)) return [];
      seen.add(normalized);
      if (needsExpansion && hasExpansion(m.index, m.text.length)) return [];

      return [
        ctx.diag(rule.name, m.offset, rule.message.replace("$match", m.text), m.text, {
          length: m.text.length,
          help: rule.help,
          suggestion: rule.suggestion,
        }),
      ];
    });
  });
}

const SMALL_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "but",
  "or",
  "for",
  "nor",
  "on",
  "at",
  "to",
  "by",
  "of",
  "in",
]);

type CaseType = "lower" | "upper" | "title" | "sentence";

/** Handler registry for casing checks - per AGENTS.md pattern */
const CASE_CHECKERS: Record<CaseType, (w: string, i: number) => boolean> = {
  lower: (w) => w === w.toLowerCase(),
  upper: (w) => w === w.toUpperCase(),
  title: (w, i) => {
    const first = w[0] ?? "";
    return i > 0 && SMALL_WORDS.has(w.toLowerCase())
      ? w === w.toLowerCase()
      : first === first.toUpperCase() && w.slice(1) === w.slice(1).toLowerCase();
  },
  sentence: (w, i) => {
    const first = w[0] ?? "";
    return i === 0 ? first === first.toUpperCase() : w === w.toLowerCase();
  },
};

/** Handler registry for casing fixes - per AGENTS.md pattern */
const CASE_FIXERS: Record<CaseType, (w: string, i: number) => string> = {
  lower: (w) => w.toLowerCase(),
  upper: (w) => w.toUpperCase(),
  title: (w, i) =>
    i > 0 && SMALL_WORDS.has(w.toLowerCase())
      ? w.toLowerCase()
      : (w[0] ?? "").toUpperCase() + w.slice(1).toLowerCase(),
  sentence: (w, i) =>
    i === 0 ? (w[0] ?? "").toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase(),
};

export function runCasingRule(
  rule: CasingRule,
  spans: TextSpan[],
  file: string,
  lineIndex: LineIndex,
): Diagnostic[] {
  const ctx = new RuleContext(file, lineIndex, rule.severity ?? "warning");
  const exceptions = new Set(rule.exceptions ?? []);
  const checker = CASE_CHECKERS[rule.case];
  const fixer = CASE_FIXERS[rule.case];

  const checkWord = (w: string, i: number): boolean => {
    if (exceptions.has(w)) return true;
    return checker ? checker(w, i) : true;
  };

  const fixWord = (w: string, i: number, isWhitespace: boolean): string => {
    if (isWhitespace || exceptions.has(w)) return w;
    return fixer ? fixer(w, i) : w;
  };

  return spans.flatMap((span) => {
    const words = span.text.split(/\s+/).filter(Boolean);
    if (words.every((w, i) => checkWord(w, i))) return [];

    const { text: fixed } = span.text.split(/(\s+)/).reduce<{ text: string; wordIdx: number }>(
      (acc, part) => {
        if (!part) return acc;
        const isWs = /^\s+$/.test(part);
        const result = fixWord(part, acc.wordIdx, isWs);
        return { text: acc.text + result, wordIdx: isWs ? acc.wordIdx : acc.wordIdx + 1 };
      },
      { text: "", wordIdx: 0 },
    );

    return [
      ctx.diag(rule.name, span.offset, rule.message.replace("$match", span.text), span.text, {
        length: span.text.length,
        fix: { start: span.offset, end: span.offset + span.text.length, text: fixed },
        help: rule.help,
        suggestion: rule.suggestion,
      }),
    ];
  });
}

export function runBanRule(
  rule: BanRule,
  spans: TextSpan[],
  file: string,
  lineIndex: LineIndex,
): Diagnostic[] {
  const ctx = new RuleContext(file, lineIndex, rule.severity ?? "warning");
  const patterns = [rule.pattern].flat();

  return spans.flatMap((span) =>
    patterns.flatMap((p) => {
      const regex = buildPattern(p, rule.regex ?? false, rule.ignoreCase ?? true);
      return [...ctx.scan(span.text, regex, span.offset)].map((m) =>
        ctx.diag(rule.name, m.offset, rule.message.replace("$match", m.text), m.text, {
          length: m.text.length,
          fix: calcFix(rule.fix as FixDef, span.text, m.index, m.text, span.offset),
          help: rule.help,
          suggestion: rule.suggestion,
        }),
      );
    }),
  );
}

export function runReplaceRule(
  rule: ReplaceRule,
  spans: TextSpan[],
  file: string,
  lineIndex: LineIndex,
): Diagnostic[] {
  const ctx = new RuleContext(file, lineIndex, rule.severity ?? "warning");
  const keys = Object.keys(rule.swap);
  if (!keys.length) return [];

  const regex = patternFromList(keys, rule.ignoreCase ?? true);
  const shouldPreserve = rule.preserveCase ?? true;

  return spans.flatMap((span) =>
    [...ctx.scan(span.text, regex, span.offset)].flatMap((m) => {
      const lower = m.text.toLowerCase();
      const replacement = Object.entries(rule.swap).find(([k]) => k.toLowerCase() === lower)?.[1];
      if (!replacement) return [];

      const finalReplacement = shouldPreserve ? preserveCase(m.text, replacement) : replacement;
      const msg = rule.message.replace("$match", m.text).replace("$replacement", finalReplacement);

      return [
        ctx.diag(rule.name, m.offset, msg, m.text, {
          length: m.text.length,
          fix: { start: m.offset, end: m.offset + m.text.length, text: finalReplacement },
          help: rule.help,
          suggestion: rule.suggestion,
        }),
      ];
    }),
  );
}

export function runMatchRule(
  rule: MatchRule,
  spans: TextSpan[],
  file: string,
  lineIndex: LineIndex,
): Diagnostic[] {
  const ctx = new RuleContext(file, lineIndex, rule.severity ?? "warning");
  const regex = buildPattern(rule.pattern, rule.regex ?? false, rule.ignoreCase ?? true);

  if (rule.negate) {
    const { text, offset } = RuleContext.combine(spans);
    if (regex.test(text)) return [];
    return [
      ctx.diag(rule.name, offset, rule.message.replace("$match", rule.pattern), rule.pattern, {
        help: rule.help,
        suggestion: rule.suggestion,
      }),
    ];
  }

  return spans.flatMap((span) =>
    [...ctx.scan(span.text, regex, span.offset)].map((m) =>
      ctx.diag(rule.name, m.offset, rule.message.replace("$match", m.text), m.text, {
        length: m.text.length,
        fix: calcFix(rule.fix as FixDef, span.text, m.index, m.text, span.offset),
        help: rule.help,
        suggestion: rule.suggestion,
      }),
    ),
  );
}

// ============================================================================
// Custom Function Rules
// ============================================================================

interface CachedRule {
  rule: Rule;
  loadedAt: number;
}

const RULE_CACHE_TTL = 5000; // 5 seconds - allows hot reload in development
const customFunctionCache = new Map<string, CachedRule>();

export function clearCustomFunctionCache(): void {
  customFunctionCache.clear();
}

async function resolveCustomFunctionPath(functionPath: string, basePath?: string): Promise<string> {
  const { resolve, dirname, isAbsolute } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const toPath = (p: string) => (p.startsWith("file://") ? fileURLToPath(p) : p);

  if (isAbsolute(functionPath)) return functionPath;
  if (functionPath.startsWith("./") || functionPath.startsWith("../")) {
    return resolve(basePath ? dirname(toPath(basePath)) : process.cwd(), functionPath);
  }
  return functionPath;
}

async function loadCustomFunction(functionPath: string, basePath?: string): Promise<Rule> {
  const resolved = await resolveCustomFunctionPath(functionPath, basePath);
  const now = Date.now();

  const cached = customFunctionCache.get(resolved);
  if (cached && now - cached.loadedAt < RULE_CACHE_TTL) {
    return cached.rule;
  }

  let mod: Record<string, unknown>;
  try {
    // Cache-busting timestamp for fresh imports in long-running processes
    mod = (await import(/* @vite-ignore */ `${resolved}?t=${now}`)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `Failed to load custom rule from '${functionPath}': ${e instanceof Error ? e.message : e}`,
      { cause: e },
    );
  }

  const fn =
    typeof mod.default === "function"
      ? mod.default
      : typeof mod.rule === "function"
        ? mod.rule
        : null;
  if (!fn)
    throw new Error(
      `Custom rule module '${functionPath}' must export a default function or a function named 'rule'`,
    );

  customFunctionCache.set(resolved, { rule: fn as Rule, loadedAt: now });
  return fn as Rule;
}

export async function runCustomFunctionRule(
  rule: CustomFunctionRule,
  spans: TextSpan[],
  file: string,
  lineIndex: LineIndex,
  basePath?: string,
): Promise<Diagnostic[]> {
  if (rule.enabled === false) return [];

  const fn = await loadCustomFunction(rule.function, basePath);
  let diagnostics: Diagnostic[];
  try {
    diagnostics = fn(spans, file, lineIndex);
  } catch (e) {
    throw new Error(`Custom rule '${rule.name}' failed: ${e instanceof Error ? e.message : e}`, {
      cause: e,
    });
  }

  if (!Array.isArray(diagnostics)) {
    throw new Error(
      `Custom rule '${rule.name}' must return an array of diagnostics, got ${typeof diagnostics}`,
    );
  }

  const severity = rule.severity ?? "warning";
  return diagnostics.map((d) => {
    const help = d.help || rule.help;
    const suggestion = d.suggestion || rule.suggestion;
    const result: Diagnostic = Object.assign({}, d, {
      rule: d.rule || rule.name,
      severity: d.severity || severity,
    });
    if (help !== undefined) result.help = help;
    if (suggestion !== undefined) result.suggestion = suggestion;
    return result;
  });
}
