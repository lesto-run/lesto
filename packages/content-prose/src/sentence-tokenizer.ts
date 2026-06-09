/**
 * Simple sentence tokenizer that handles common abbreviations
 * and edge cases without external dependencies.
 */

const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "vs",
  "etc",
  "inc",
  "ltd",
  "corp",
  "co",
  "eg",
  "ie",
  "al",
  "ca",
  "cf",
  "ed",
  "est",
  "vol",
  "no",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
]);

const SENTENCE_END_PATTERN = /([.!?]+)(\s+)(?=[A-Z"'([])/g;

export interface Sentence {
  text: string;
  offset: number;
  wordCount: number;
  charCount: number;
}

/**
 * Count words in text using word boundary regex.
 * Matches the pattern used in rules.ts: /\b\w+\b/gi
 */
function countWords(text: string): number {
  const matches = text.match(/\b\w+\b/g);
  return matches ? matches.length : 0;
}

/**
 * Count alphanumeric characters (excludes spaces, punctuation).
 */
function countAlphanumeric(text: string): number {
  const matches = text.match(/[a-zA-Z0-9]/g);
  return matches ? matches.length : 0;
}

/**
 * Check if text ends with a common abbreviation.
 */
function endsWithAbbreviation(text: string): boolean {
  const match = text.match(/\b([A-Za-z]{1,4})\.\s*$/);
  if (!match || match[1] === undefined) return false;
  return ABBREVIATIONS.has(match[1].toLowerCase());
}

/**
 * Tokenize text into sentences with offsets.
 * Handles abbreviations, quotes, and multi-sentence paragraphs.
 *
 * @param text - The text to tokenize
 * @param baseOffset - Starting offset in the source document (for spans)
 * @returns Array of sentences with metadata
 */
export function tokenizeSentences(text: string, baseOffset = 0): Sentence[] {
  const sentences: Sentence[] = [];

  // Split on sentence boundaries
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Clone regex for safe iteration
  const pattern = new RegExp(SENTENCE_END_PATTERN.source, "g");

  while ((match = pattern.exec(text)) !== null) {
    const sentenceEnd = match.index + (match[1]?.length ?? 0);
    const candidateSentence = text.slice(lastIndex, sentenceEnd);

    // Skip if this looks like an abbreviation
    if (endsWithAbbreviation(candidateSentence)) {
      continue;
    }

    const trimmed = candidateSentence.trim();
    if (trimmed.length === 0) continue;

    // Account for leading whitespace removed by trim()
    const leadingWhitespace = candidateSentence.length - candidateSentence.trimStart().length;
    sentences.push({
      text: trimmed,
      offset: baseOffset + lastIndex + leadingWhitespace,
      wordCount: countWords(trimmed),
      charCount: countAlphanumeric(trimmed),
    });

    // Move past the whitespace
    lastIndex = match.index + match[0].length;
  }

  // Handle remaining text (last sentence without trailing punctuation/space)
  if (lastIndex < text.length) {
    const remainingRaw = text.slice(lastIndex);
    const remaining = remainingRaw.trim();
    if (remaining.length > 0) {
      // Account for leading whitespace removed by trim()
      const leadingWhitespace = remainingRaw.length - remainingRaw.trimStart().length;
      sentences.push({
        text: remaining,
        offset: baseOffset + lastIndex + leadingWhitespace,
        wordCount: countWords(remaining),
        charCount: countAlphanumeric(remaining),
      });
    }
  }

  return sentences;
}

/**
 * Calculate Automated Readability Index for a sentence.
 * Formula: 4.71 × (chars/words) + 0.5 × words - 21.43
 *
 * @param sentence - Sentence with word and character counts
 * @returns ARI score (higher = more difficult)
 */
export function calculateARI(sentence: Sentence): number {
  if (sentence.wordCount === 0) return 0;

  const charsPerWord = sentence.charCount / sentence.wordCount;
  return 4.71 * charsPerWord + 0.5 * sentence.wordCount - 21.43;
}
