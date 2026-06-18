/**
 * Spelling checker module using typo-js for browser-compatible spell checking.
 *
 * Supports:
 * - en_US dictionary by default
 * - Custom dictionary loading
 * - Technical terms skip list (camelCase, ALL_CAPS, etc.)
 *
 * Note: This module uses dynamic imports for Node.js-specific APIs.
 * The spell checker must be explicitly initialized before use.
 */

import Typo from "typo-js";
import { createSingletonLoader } from "@volo/content-shared/mutex";

/**
 * Spell checker instance wrapping typo-js.
 */
export interface SpellChecker {
  /** Check if a word is spelled correctly */
  check(word: string): boolean;
  /** Get spelling suggestions for a misspelled word */
  suggest(word: string, limit?: number): string[];
  /** Check if the checker is initialized */
  isReady(): boolean;
  /** Add a word to the custom dictionary */
  addWord(word: string): void;
  /** Check if a word should be skipped (technical terms, etc.) */
  shouldSkip(word: string): boolean;
}

/**
 * Options for creating a spell checker.
 */
export interface SpellCheckerOptions {
  /** Language code (default: 'en_US') */
  language?: string;
  /** Path to custom dictionary file */
  customDictionary?: string;
  /** Additional words to add to the dictionary */
  additionalWords?: string[];
  /** Pre-loaded dictionary data (for browser usage) */
  dictionaryData?: {
    aff: string;
    dic: string;
  };
}

// Skip patterns for technical terms
const CAMEL_CASE_PATTERN = /^[a-z]+([A-Z][a-z]*)+$/;
const ALL_CAPS_PATTERN = /^[A-Z][A-Z0-9_]+$/;
const SNAKE_CASE_PATTERN = /^[a-z]+(_[a-z]+)+$/;
const KEBAB_CASE_PATTERN = /^[a-z]+(-[a-z]+)+$/;
const FILE_EXTENSION_PATTERN = /^\.\w+$/;
const URL_PATTERN = /^https?:\/\//;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Check if a word should be skipped (technical terms, code identifiers, etc.)
 */
export function shouldSkipWord(word: string): boolean {
  // Very short words (1-2 chars) - often abbreviations
  if (word.length <= 2) return true;

  // Contains numbers
  if (/\d/.test(word)) return true;

  // Programming identifiers and patterns
  if (CAMEL_CASE_PATTERN.test(word)) return true;
  if (ALL_CAPS_PATTERN.test(word)) return true;
  if (SNAKE_CASE_PATTERN.test(word)) return true;
  if (KEBAB_CASE_PATTERN.test(word)) return true;

  // File extensions
  if (FILE_EXTENSION_PATTERN.test(word)) return true;

  // URLs and emails
  if (URL_PATTERN.test(word)) return true;
  if (EMAIL_PATTERN.test(word)) return true;

  // Contractions (handled separately)
  if (word.includes("'") || word.includes("'")) return true;

  return false;
}

/**
 * Default options for the singleton spell checker.
 */
const defaultOptions: SpellCheckerOptions = {};

/**
 * Create the singleton loader function.
 * Wrapped in a function to support reset for testing.
 */
function createLoader() {
  return createSingletonLoader<SpellChecker>(async () => {
    return createSpellChecker(defaultOptions);
  });
}

/**
 * Singleton spell checker loader using createSingletonLoader to prevent race conditions.
 * Note: Options cannot be customized after first initialization. For custom options,
 * use createSpellChecker directly instead of getSpellChecker.
 */
let loadSpellChecker = createLoader();

/**
 * Singleton spell checker instance (for sync access).
 */
let checkerInstance: SpellChecker | null = null;

/**
 * Create a spell checker with the specified options.
 */
export async function createSpellChecker(options: SpellCheckerOptions = {}): Promise<SpellChecker> {
  const language = options.language ?? "en_US";

  // Create typo instance
  // - If dictionaryData provided (browser), use it
  // - Otherwise let typo-js load its built-in dictionary (Node.js)
  const typo = options.dictionaryData
    ? new Typo(language, options.dictionaryData.aff, options.dictionaryData.dic)
    : new Typo(language);

  // Custom words set
  const customWords = new Set<string>(options.additionalWords ?? []);

  // Caches for performance (check and suggest are expensive)
  const checkCache = new Map<string, boolean>();
  const suggestCache = new Map<string, string[]>();

  // Load custom dictionary if provided (Node.js only)
  if (options.customDictionary) {
    try {
      const { readFile } = await import("node:fs/promises");
      const customContent = await readFile(options.customDictionary, "utf-8");
      for (const line of customContent.split("\n")) {
        const word = line.trim();
        if (word && !word.startsWith("#")) {
          customWords.add(word.toLowerCase());
        }
      }
    } catch (error) {
      console.warn(`Failed to load custom dictionary: ${options.customDictionary}`, error);
    }
  }

  const checker: SpellChecker = {
    check(word: string): boolean {
      const lower = word.toLowerCase();
      // Check custom words first
      if (customWords.has(lower)) return true;
      // Check cache
      const cached = checkCache.get(lower);
      if (cached !== undefined) return cached;
      // Check typo and cache result
      const result = typo.check(word);
      checkCache.set(lower, result);
      return result;
    },

    suggest(word: string, limit = 5): string[] {
      const lower = word.toLowerCase();
      const cacheKey = `${lower}:${limit}`;
      // Check cache
      const cached = suggestCache.get(cacheKey);
      if (cached) return cached;
      // Get suggestions and cache
      const suggestions = typo.suggest(word, limit);
      suggestCache.set(cacheKey, suggestions);
      return suggestions;
    },

    isReady(): boolean {
      return true;
    },

    addWord(word: string): void {
      customWords.add(word.toLowerCase());
    },

    shouldSkip(word: string): boolean {
      return shouldSkipWord(word);
    },
  };

  return checker;
}

/**
 * Get or create the singleton spell checker instance.
 * Uses createSingletonLoader to prevent race conditions during initialization.
 *
 * Note: For custom options, use createSpellChecker directly.
 * This function always uses default options to ensure consistency.
 */
export async function getSpellChecker(): Promise<SpellChecker> {
  const checker = await loadSpellChecker();
  checkerInstance = checker; // Keep sync reference updated
  return checker;
}

/**
 * Reset the spell checker singleton (for testing).
 */
export function resetSpellChecker(): void {
  checkerInstance = null;
  loadSpellChecker = createLoader();
}

/**
 * Get the current spell checker instance synchronously.
 * Returns null if not initialized.
 */
export function getSpellCheckerSync(): SpellChecker | null {
  return checkerInstance;
}

/**
 * Pre-warm the spell checker cache with common English words.
 * This eliminates cold-start latency on first document.
 */
export function prewarmSpellChecker(checker: SpellChecker): void {
  // Top 100 most common English words - covers ~50% of all text
  const commonWords = [
    "the",
    "be",
    "to",
    "of",
    "and",
    "a",
    "in",
    "that",
    "have",
    "i",
    "it",
    "for",
    "not",
    "on",
    "with",
    "he",
    "as",
    "you",
    "do",
    "at",
    "this",
    "but",
    "his",
    "by",
    "from",
    "they",
    "we",
    "say",
    "her",
    "she",
    "or",
    "an",
    "will",
    "my",
    "one",
    "all",
    "would",
    "there",
    "their",
    "what",
    "so",
    "up",
    "out",
    "if",
    "about",
    "who",
    "get",
    "which",
    "go",
    "me",
    "when",
    "make",
    "can",
    "like",
    "time",
    "no",
    "just",
    "him",
    "know",
    "take",
    "people",
    "into",
    "year",
    "your",
    "good",
    "some",
    "could",
    "them",
    "see",
    "other",
    "than",
    "then",
    "now",
    "look",
    "only",
    "come",
    "its",
    "over",
    "think",
    "also",
    "back",
    "after",
    "use",
    "two",
    "how",
    "our",
    "work",
    "first",
    "well",
    "way",
    "even",
    "new",
    "want",
    "because",
    "any",
    "these",
    "give",
    "day",
    "most",
    "us",
    // Additional common words for prose content
    "here",
    "should",
    "need",
    "has",
    "more",
    "very",
    "been",
    "was",
    "were",
    "being",
    "are",
    "is",
    "am",
    "does",
    "did",
    "done",
    "doing",
    "made",
    "making",
    "got",
    "getting",
    "going",
    "went",
    "said",
    "saying",
    "told",
    "tell",
    "telling",
    "asked",
    "ask",
    "using",
    "used",
    "works",
    "working",
    "worked",
    "makes",
    "gives",
    "gave",
    "given",
    "takes",
    "took",
    "taken",
    "comes",
    "came",
    "coming",
    "goes",
    "gone",
    "sees",
    "saw",
    "seen",
    "knows",
    "knew",
    "known",
    "thinks",
    "thought",
    "thinking",
    "wants",
    "wanted",
    "wanting",
    "gets",
    "finds",
    "found",
    "finding",
    "shows",
    "showed",
    "shown",
    "showing",
    "means",
    "meant",
    "keeps",
    "kept",
    "keeping",
    "lets",
    "let",
    "letting",
    "begins",
    "began",
    "begun",
    "beginning",
    "seems",
    "seemed",
    "seeming",
    "leaves",
    "left",
    "leaving",
    "calls",
    "called",
    "calling",
    "tries",
    "tried",
    "trying",
    "provides",
    "provided",
    "providing",
    "includes",
    "included",
    "including",
  ];

  for (const word of commonWords) {
    checker.check(word);
  }
}
