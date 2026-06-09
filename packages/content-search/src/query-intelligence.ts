/**
 * Query Intelligence Layer
 *
 * Preprocesses search queries with:
 * 1. Typo tolerance (BK-tree fuzzy matching)
 * 2. Stemming (Porter algorithm)
 * 3. Synonym expansion
 * 4. Tokenization and normalization
 */

import type { ProcessedQuery, QueryIntelligenceOptions } from "./types";

// ============================================================================
// Porter Stemmer (English)
// ============================================================================

const STEP_2_SUFFIXES: Array<[string, string]> = [
  ["ational", "ate"],
  ["tional", "tion"],
  ["enci", "ence"],
  ["anci", "ance"],
  ["izer", "ize"],
  ["abli", "able"],
  ["alli", "al"],
  ["entli", "ent"],
  ["eli", "e"],
  ["ousli", "ous"],
  ["ization", "ize"],
  ["ation", "ate"],
  ["ator", "ate"],
  ["alism", "al"],
  ["iveness", "ive"],
  ["fulness", "ful"],
  ["ousness", "ous"],
  ["aliti", "al"],
  ["iviti", "ive"],
  ["biliti", "ble"],
];

const STEP_3_SUFFIXES: Array<[string, string]> = [
  ["icate", "ic"],
  ["ative", ""],
  ["alize", "al"],
  ["iciti", "ic"],
  ["ical", "ic"],
  ["ful", ""],
  ["ness", ""],
];

const STEP_4_SUFFIXES = [
  "al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement",
  "ment", "ent", "ion", "ou", "ism", "ate", "iti", "ous", "ive", "ize",
];

function isConsonant(word: string, i: number): boolean {
  const c = word[i];
  if (c === undefined) return false;
  if ("aeiou".includes(c)) return false;
  if (c === "y") return i === 0 || !isConsonant(word, i - 1);
  return true;
}

function getMeasure(word: string): number {
  let count = 0;
  let prevIsConsonant = true;

  for (let i = 0; i < word.length; i++) {
    const currIsConsonant = isConsonant(word, i);
    if (currIsConsonant && !prevIsConsonant) {
      count++;
    }
    prevIsConsonant = currIsConsonant;
  }

  return count;
}

function hasVowel(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    if (!isConsonant(word, i)) return true;
  }
  return false;
}

function endsWithDoubleConsonant(word: string): boolean {
  if (word.length < 2) return false;
  const last = word[word.length - 1];
  const secondLast = word[word.length - 2];
  return (
    last === secondLast &&
    last !== undefined &&
    isConsonant(word, word.length - 1)
  );
}

function endsCVC(word: string): boolean {
  if (word.length < 3) return false;
  const last = word[word.length - 1];
  return (
    isConsonant(word, word.length - 1) &&
    !isConsonant(word, word.length - 2) &&
    isConsonant(word, word.length - 3) &&
    last !== undefined &&
    !"wxy".includes(last)
  );
}

/**
 * Stem a word using the Porter algorithm.
 */
export function stem(word: string): string {
  if (word.length < 3) return word;

  word = word.toLowerCase();

  // Step 1a
  if (word.endsWith("sses")) {
    word = word.slice(0, -2);
  } else if (word.endsWith("ies")) {
    word = word.slice(0, -2);
  } else if (!word.endsWith("ss") && word.endsWith("s")) {
    word = word.slice(0, -1);
  }

  // Step 1b
  if (word.endsWith("eed")) {
    if (getMeasure(word.slice(0, -3)) > 0) {
      word = word.slice(0, -1);
    }
  } else if (word.endsWith("ed")) {
    const stemWord = word.slice(0, -2);
    if (hasVowel(stemWord)) {
      word = stemWord;
      if (word.endsWith("at") || word.endsWith("bl") || word.endsWith("iz")) {
        word += "e";
      } else if (
        endsWithDoubleConsonant(word) &&
        !word.endsWith("l") &&
        !word.endsWith("s") &&
        !word.endsWith("z")
      ) {
        word = word.slice(0, -1);
      } else if (getMeasure(word) === 1 && endsCVC(word)) {
        word += "e";
      }
    }
  } else if (word.endsWith("ing")) {
    const stemWord = word.slice(0, -3);
    if (hasVowel(stemWord)) {
      word = stemWord;
      if (word.endsWith("at") || word.endsWith("bl") || word.endsWith("iz")) {
        word += "e";
      } else if (
        endsWithDoubleConsonant(word) &&
        !word.endsWith("l") &&
        !word.endsWith("s") &&
        !word.endsWith("z")
      ) {
        word = word.slice(0, -1);
      } else if (getMeasure(word) === 1 && endsCVC(word)) {
        word += "e";
      }
    }
  }

  // Step 1c
  if (word.endsWith("y") && hasVowel(word.slice(0, -1))) {
    word = word.slice(0, -1) + "i";
  }

  // Step 2
  for (const [suffix, replacement] of STEP_2_SUFFIXES) {
    if (word.endsWith(suffix)) {
      const stemWord = word.slice(0, -suffix.length);
      if (getMeasure(stemWord) > 0) {
        word = stemWord + replacement;
      }
      break;
    }
  }

  // Step 3
  for (const [suffix, replacement] of STEP_3_SUFFIXES) {
    if (word.endsWith(suffix)) {
      const stemWord = word.slice(0, -suffix.length);
      if (getMeasure(stemWord) > 0) {
        word = stemWord + replacement;
      }
      break;
    }
  }

  // Step 4
  for (const suffix of STEP_4_SUFFIXES) {
    if (word.endsWith(suffix)) {
      const stemWord = word.slice(0, -suffix.length);
      if (getMeasure(stemWord) > 1) {
        if (suffix === "ion") {
          const lastChar = stemWord[stemWord.length - 1];
          if (lastChar === "s" || lastChar === "t") {
            word = stemWord;
          }
        } else {
          word = stemWord;
        }
      }
      break;
    }
  }

  // Step 5a
  if (word.endsWith("e")) {
    const stemWord = word.slice(0, -1);
    if (getMeasure(stemWord) > 1 || (getMeasure(stemWord) === 1 && !endsCVC(stemWord))) {
      word = stemWord;
    }
  }

  // Step 5b
  if (getMeasure(word) > 1 && endsWithDoubleConsonant(word) && word.endsWith("l")) {
    word = word.slice(0, -1);
  }

  return word;
}

// ============================================================================
// BK-Tree for Typo Tolerance
// ============================================================================

interface BKNode {
  word: string;
  children: Map<number, BKNode>;
}

/**
 * Calculate Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a === b) return 0;

  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;

  const row: number[] = Array.from({ length: shorter.length + 1 }, (_, i) => i);

  for (let i = 1; i <= longer.length; i++) {
    let prev = i;
    for (let j = 1; j <= shorter.length; j++) {
      const current = row[j - 1]!;
      const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
      row[j - 1] = prev;
      const prevRow = row[j]!;
      prev = Math.min(
        prevRow + 1,
        prev + 1,
        current + cost
      );
    }
    row[shorter.length] = prev;
  }

  return row[shorter.length]!;
}

/** Maximum vocabulary size to prevent unbounded memory growth */
const MAX_VOCABULARY_SIZE = 50000;

/**
 * BK-tree for efficient fuzzy string matching.
 */
export class BKTree {
  private root: BKNode | null = null;
  private size = 0;
  private words = new Set<string>();
  private maxSize: number;

  constructor(maxSize = MAX_VOCABULARY_SIZE) {
    this.maxSize = maxSize;
  }

  static build(words: string[], maxSize = MAX_VOCABULARY_SIZE): BKTree {
    const tree = new BKTree(maxSize);
    for (const word of words) {
      if (tree.size >= maxSize) break;
      tree.add(word);
    }
    return tree;
  }

  add(word: string): boolean {
    // Deduplicate and enforce size limit
    if (this.words.has(word) || this.size >= this.maxSize) {
      return false;
    }

    if (!this.root) {
      this.root = { word, children: new Map() };
      this.words.add(word);
      this.size = 1;
      return true;
    }

    let current = this.root;
    while (true) {
      const distance = levenshteinDistance(word, current.word);
      if (distance === 0) return false;

      const child = current.children.get(distance);
      if (!child) {
        current.children.set(distance, { word, children: new Map() });
        this.words.add(word);
        this.size++;
        return true;
      }
      current = child;
    }
  }

  suggest(query: string, maxDistance: number): Array<{ word: string; distance: number }> {
    const results: Array<{ word: string; distance: number }> = [];

    if (!this.root) return results;

    const stack: BKNode[] = [this.root];

    while (stack.length > 0) {
      const node = stack.pop()!;
      const distance = levenshteinDistance(query, node.word);

      if (distance <= maxDistance) {
        results.push({ word: node.word, distance });
      }

      const minDistance = Math.max(0, distance - maxDistance);
      const maxCheck = distance + maxDistance;

      for (const [d, child] of node.children) {
        if (d >= minDistance && d <= maxCheck) {
          stack.push(child);
        }
      }
    }

    return results.toSorted((a, b) =>
      a.distance !== b.distance ? a.distance - b.distance : a.word.localeCompare(b.word)
    );
  }

  has(word: string): boolean {
    if (!this.root) return false;

    let current: BKNode | undefined = this.root;
    while (current) {
      const distance = levenshteinDistance(word, current.word);
      if (distance === 0) return true;
      current = current.children.get(distance);
    }
    return false;
  }

  getSize(): number {
    return this.size;
  }
}

// ============================================================================
// Synonym Expansion
// ============================================================================

export const DEFAULT_SYNONYMS: string[][] = [
  ["auth", "authentication", "login", "signin", "sign-in"],
  ["logout", "signout", "sign-out"],
  ["user", "account", "profile"],
  ["password", "pwd", "pass", "passphrase"],
  ["token", "jwt", "bearer"],
  ["permission", "authorization", "access", "acl"],
  ["api", "endpoint", "route", "interface"],
  ["request", "req", "call"],
  ["response", "res", "reply"],
  ["get", "fetch", "retrieve", "read"],
  ["post", "create", "submit", "send"],
  ["put", "update", "modify", "patch"],
  ["delete", "remove", "destroy", "del"],
  ["url", "uri", "link", "href"],
  ["param", "parameter", "arg", "argument"],
  ["query", "search", "filter", "q"],
  ["deploy", "publish", "ship", "release", "launch"],
  ["build", "compile", "bundle"],
  ["config", "configuration", "settings", "options", "preferences"],
  ["env", "environment", "envvar"],
  ["secret", "credential", "key"],
  ["setup", "install", "initialize", "init"],
  ["error", "bug", "issue", "problem", "failure"],
  ["fix", "resolve", "solve", "repair"],
  ["debug", "troubleshoot", "diagnose"],
  ["log", "logging", "logs", "trace"],
  ["database", "db", "datastore"],
  ["cache", "redis", "memcache"],
  ["file", "document", "doc"],
  ["json", "yaml", "xml", "toml"],
  ["function", "func", "fn", "method"],
  ["class", "type", "interface"],
  ["component", "widget", "element"],
  ["module", "package", "library", "lib"],
  ["import", "require", "include"],
  ["export", "expose", "public"],
  ["test", "spec", "unit", "integration"],
  ["mock", "stub", "fake", "spy"],
  ["style", "css", "stylesheet"],
  ["js", "javascript"],
  ["ts", "typescript"],
  ["html", "markup", "template"],
  ["docs", "documentation", "guide", "manual"],
  ["readme", "overview", "intro", "introduction"],
  ["tutorial", "howto", "how-to", "walkthrough"],
  ["example", "sample", "demo"],
  ["reference", "ref", "api-ref"],
  ["faq", "question", "help"],
];

export function buildSynonymMap(groups: string[][]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();

  for (const group of groups) {
    for (const word of group) {
      const normalized = word.toLowerCase();
      const existing = map.get(normalized) ?? new Set<string>();
      for (const other of group) {
        const otherNormalized = other.toLowerCase();
        if (otherNormalized !== normalized) {
          existing.add(otherNormalized);
        }
      }
      map.set(normalized, existing);
    }
  }

  return map;
}

// ============================================================================
// Tokenization
// ============================================================================

export function tokenize(text: string): string[] {
  const normalized = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim()
    .replace(/[-_./]/g, " ")
    .replace(/[^a-z0-9\s]/g, "");

  return normalized.split(/\s+/).filter((word) => word.length > 0);
}

export function extractQuotedPhrases(query: string): string[] {
  const matches = query.match(/"([^"]+)"/g) ?? [];
  return matches.map((m) => m.slice(1, -1).toLowerCase().trim());
}

// ============================================================================
// Query Processor
// ============================================================================

export class QueryProcessor {
  private bkTree: BKTree | null = null;
  private vocabulary: Set<string> = new Set();
  private synonymMap: Map<string, Set<string>>;
  private options: Required<QueryIntelligenceOptions>;

  constructor(options: QueryIntelligenceOptions = {}) {
    this.options = {
      maxTypoDistance: options.maxTypoDistance ?? 2,
      enableStemming: options.enableStemming ?? true,
      enableSynonyms: options.enableSynonyms ?? true,
      customSynonyms: options.customSynonyms ?? {},
    };

    const allSynonyms = [...DEFAULT_SYNONYMS];
    for (const [word, syns] of Object.entries(this.options.customSynonyms)) {
      allSynonyms.push([word, ...syns]);
    }

    this.synonymMap = buildSynonymMap(allSynonyms);
  }

  buildVocabulary(entries: Array<{ content?: string; title?: string }>): void {
    const words = new Set<string>();

    for (const entry of entries) {
      const text = `${entry.title ?? ""} ${entry.content ?? ""}`;
      for (const word of tokenize(text)) {
        if (word.length >= 2 && word.length <= 30) {
          words.add(word);
        }
      }
    }

    this.vocabulary = words;
    this.bkTree = BKTree.build([...words]);
  }

  correctWord(word: string): { corrected: string; wasChanged: boolean } {
    if (!this.bkTree || this.vocabulary.has(word)) {
      return { corrected: word, wasChanged: false };
    }

    const suggestions = this.bkTree.suggest(word, this.options.maxTypoDistance);
    if (suggestions.length > 0 && suggestions[0]) {
      return { corrected: suggestions[0].word, wasChanged: true };
    }

    return { corrected: word, wasChanged: false };
  }

  process(query: string): ProcessedQuery {
    const original = query;
    const mustMatch = extractQuotedPhrases(query);
    const withoutQuotes = query.replace(/"[^"]+"/g, "").trim();
    const rawTerms = tokenize(withoutQuotes);

    const corrections = rawTerms.map((term) => this.correctWord(term));
    const wasTypoCorrected = corrections.some((r) => r.wasChanged);
    const correctedTerms = corrections.map((r) => r.corrected);
    const corrected = correctedTerms.join(" ");

    const allTerms = new Set(correctedTerms);

    if (this.options.enableStemming) {
      for (const term of correctedTerms) {
        const stemmed = stem(term);
        if (stemmed !== term) {
          allTerms.add(stemmed);
        }
      }
    }

    if (this.options.enableSynonyms) {
      for (const term of correctedTerms) {
        const synonyms = this.synonymMap.get(term);
        if (synonyms) {
          for (const syn of synonyms) {
            allTerms.add(syn);
          }
        }
      }
    }

    return {
      original,
      corrected,
      terms: [...allTerms],
      mustMatch,
      wasTypoCorrected,
    };
  }
}

export function createQueryProcessor(options?: QueryIntelligenceOptions): QueryProcessor {
  return new QueryProcessor(options);
}

/**
 * Simple query preprocessing without vocabulary-based typo correction.
 */
export function preprocessQuery(
  query: string,
  options: Pick<QueryIntelligenceOptions, "enableStemming" | "enableSynonyms" | "customSynonyms"> = {}
): ProcessedQuery {
  const {
    enableStemming = true,
    enableSynonyms = true,
    customSynonyms = {},
  } = options;

  const original = query;
  const mustMatch = extractQuotedPhrases(query);
  const withoutQuotes = query.replace(/"[^"]+"/g, "").trim();
  const rawTerms = tokenize(withoutQuotes);
  const corrected = rawTerms.join(" ");

  const allTerms = new Set(rawTerms);

  if (enableStemming) {
    for (const term of rawTerms) {
      const stemmed = stem(term);
      if (stemmed !== term) {
        allTerms.add(stemmed);
      }
    }
  }

  if (enableSynonyms) {
    const allSynonyms = [...DEFAULT_SYNONYMS];
    for (const [word, syns] of Object.entries(customSynonyms)) {
      allSynonyms.push([word, ...syns]);
    }
    const synonymMap = buildSynonymMap(allSynonyms);

    for (const term of rawTerms) {
      const synonyms = synonymMap.get(term);
      if (synonyms) {
        for (const syn of synonyms) {
          allTerms.add(syn);
        }
      }
    }
  }

  return {
    original,
    corrected,
    terms: [...allTerms],
    mustMatch,
    wasTypoCorrected: false,
  };
}
