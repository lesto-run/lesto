/**
 * Voice training data generation module.
 * Prepares content for fine-tuning LLMs to match author voice.
 */

import type { VoiceSample } from "./voice";

// ============================================================================
// Content Chunking (250-650 words)
// ============================================================================

/**
 * A chunk of content for training.
 */
export interface ContentChunk {
  /** Unique identifier for the chunk */
  id: string;
  /** Source entry ID */
  entryId: string;
  /** Source collection */
  collection: string;
  /** Author (if per-author profiles are enabled) */
  author?: string;
  /** The chunked content */
  text: string;
  /** Word count of the chunk */
  wordCount: number;
  /** Index of this chunk within the source entry */
  chunkIndex: number;
  /** Total number of chunks from the source entry */
  totalChunks: number;
  /** Title of the source entry (if available) */
  sourceTitle?: string;
  /** Whether the source entry is marked as exemplary */
  isExemplary: boolean;
}

/**
 * Options for content chunking.
 */
export interface ChunkingOptions {
  /** Minimum words per chunk (default: 250) */
  minWords?: number;
  /** Maximum words per chunk (default: 650) */
  maxWords?: number;
  /** Target words per chunk - algorithm tries to get close to this (default: 400) */
  targetWords?: number;
  /** Whether to allow chunks smaller than minWords for short content (default: true) */
  allowShortContent?: boolean;
}

/**
 * Default chunking options.
 */
const DEFAULT_CHUNKING_OPTIONS: Required<ChunkingOptions> = {
  minWords: 250,
  maxWords: 650,
  targetWords: 400,
  allowShortContent: true,
};

/**
 * Count words in text.
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Split text into words preserving whitespace positions.
 */
function tokenizeWords(text: string): string[] {
  return text.split(/(\s+)/);
}

function calculateCharPosition(tokens: string[], targetWordIndex: number): number {
  let charPos = 0;
  let wordCount = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (!/^\s+$/.test(token) && token) {
      wordCount++;
      if (wordCount >= targetWordIndex) {
        charPos += token.length;
        break;
      }
    }
    charPos += token.length;
  }
  return charPos;
}

function findBestPatternMatch(searchText: string, patterns: string[]): number {
  let best = -1;
  for (const pattern of patterns) {
    const pos = searchText.lastIndexOf(pattern);
    if (pos > best) {
      best = pos;
    }
  }
  return best;
}

function findBestBreakPoint(text: string, targetWordIndex: number, tokens: string[]): number {
  const charPos = calculateCharPosition(tokens, targetWordIndex);
  const searchStart = Math.max(0, charPos - 100);
  const searchEnd = Math.min(text.length, charPos + 100);
  const searchText = text.slice(searchStart, searchEnd);

  const paragraphBreak = searchText.lastIndexOf("\n\n");
  if (paragraphBreak !== -1) {
    return searchStart + paragraphBreak + 2;
  }

  const sentenceEnd = findBestPatternMatch(searchText, [". ", ".\n", "! ", "!\n", "? ", "?\n"]);
  if (sentenceEnd !== -1) {
    return searchStart + sentenceEnd + 2;
  }

  const clauseBreak = findBestPatternMatch(searchText, ["; ", ";\n", ": ", ":\n", ", "]);
  if (clauseBreak !== -1) {
    return searchStart + clauseBreak + 2;
  }

  const lastSpace = searchText.lastIndexOf(" ");
  if (lastSpace !== -1) {
    return searchStart + lastSpace + 1;
  }

  return charPos;
}

function handleShortContent(
  content: string,
  totalWords: number,
  minWords: number,
  maxWords: number,
  allowShortContent: boolean,
): string[] | null {
  if (totalWords <= minWords) {
    return allowShortContent ? [content.trim()] : [];
  }
  if (totalWords <= maxWords) {
    return [content.trim()];
  }
  return null;
}

function adjustChunkSize(
  remainingText: string,
  breakPoint: number,
  chunk: string,
  chunkWordCount: number,
  minWords: number,
  maxWords: number,
): { chunk: string; breakPoint: number } {
  let adjustedChunk = chunk;
  let adjustedBreakPoint = breakPoint;

  if (chunkWordCount < minWords && breakPoint < remainingText.length) {
    const extendedBreakPoint = findBestBreakPoint(
      remainingText,
      minWords + 50,
      tokenizeWords(remainingText),
    );
    if (extendedBreakPoint > breakPoint) {
      adjustedChunk = remainingText.slice(0, extendedBreakPoint).trim();
      adjustedBreakPoint = extendedBreakPoint;
    }
  }

  const adjustedWordCount = countWords(adjustedChunk);
  if (adjustedWordCount > maxWords) {
    const shrunkBreakPoint = findBestBreakPoint(
      remainingText,
      maxWords - 50,
      tokenizeWords(remainingText),
    );
    if (shrunkBreakPoint > 0) {
      adjustedChunk = remainingText.slice(0, shrunkBreakPoint).trim();
      adjustedBreakPoint = shrunkBreakPoint;
    }
  }

  return { chunk: adjustedChunk, breakPoint: adjustedBreakPoint };
}

/** Check if remaining content can be added as final chunk */
function tryAddFinalChunk(
  remainingText: string,
  maxWords: number,
  minWords: number,
  allowShortContent: boolean,
): string | null {
  if (countWords(remainingText) > maxWords) return null;
  const trimmed = remainingText.trim();
  const isValid = trimmed && (allowShortContent || countWords(trimmed) >= minWords);
  return isValid ? trimmed : null;
}

/** Process one iteration of chunking and return advancement */
function processChunkIteration(
  remainingText: string,
  targetWords: number,
  maxWords: number,
  minWords: number,
  chunks: string[],
): number {
  const targetBreakWords = Math.min(targetWords, maxWords);
  const initialBreakPoint = findBestBreakPoint(
    remainingText,
    targetBreakWords,
    tokenizeWords(remainingText),
  );

  const initialChunk = remainingText.slice(0, initialBreakPoint).trim();
  const initialWordCount = countWords(initialChunk);

  const { chunk, breakPoint } = adjustChunkSize(
    remainingText,
    initialBreakPoint,
    initialChunk,
    initialWordCount,
    minWords,
    maxWords,
  );

  if (chunk) chunks.push(chunk);

  // Use explicit zero check to avoid treating breakPoint=0 as falsy
  const advancement = breakPoint !== 0 ? breakPoint : chunk.length || 1;
  return advancement;
}

export function chunkContent(content: string, options: ChunkingOptions = {}): string[] {
  const opts = { ...DEFAULT_CHUNKING_OPTIONS, ...options };
  const { minWords, maxWords, targetWords, allowShortContent } = opts;

  const shortResult = handleShortContent(
    content,
    countWords(content),
    minWords,
    maxWords,
    allowShortContent,
  );
  if (shortResult !== null) return shortResult;

  const chunks: string[] = [];
  let currentPosition = 0;

  while (currentPosition < content.length) {
    const remainingText = content.slice(currentPosition);

    const finalChunk = tryAddFinalChunk(remainingText, maxWords, minWords, allowShortContent);
    if (finalChunk !== null) {
      if (finalChunk) chunks.push(finalChunk);
      break;
    }

    const advancement = processChunkIteration(
      remainingText,
      targetWords,
      maxWords,
      minWords,
      chunks,
    );
    if (advancement === 0) {
      console.warn(
        "[Voice Training] Zero advancement in chunking loop, breaking to prevent infinite loop",
      );
      break;
    }
    currentPosition += advancement;
  }

  return chunks;
}

/**
 * Generate a unique chunk ID.
 */
function generateChunkId(entryId: string, chunkIndex: number): string {
  return `${entryId}:chunk:${chunkIndex}`;
}

/**
 * Chunk a voice sample into training chunks.
 */
export function chunkVoiceSample(
  sample: VoiceSample,
  options: ChunkingOptions = {},
): ContentChunk[] {
  const textChunks = chunkContent(sample.content, options);

  return textChunks.map((text, index) => {
    const chunk: ContentChunk = {
      id: generateChunkId(sample.entryId, index),
      entryId: sample.entryId,
      collection: sample.collection,
      text,
      wordCount: countWords(text),
      chunkIndex: index,
      totalChunks: textChunks.length,
      isExemplary: sample.isExemplary,
    };
    if (sample.author !== undefined) chunk.author = sample.author;
    if (sample.title !== undefined) chunk.sourceTitle = sample.title;
    return chunk;
  });
}

/**
 * Chunk multiple voice samples into training chunks.
 */
export function chunkVoiceSamples(
  samples: VoiceSample[],
  options: ChunkingOptions = {},
): ContentChunk[] {
  return samples.flatMap((sample) => chunkVoiceSample(sample, options));
}

// ============================================================================
// Instruction Generation
// ============================================================================

/**
 * Types of instructions that can be generated.
 */
export type InstructionType =
  | "continue"
  | "write"
  | "explain"
  | "summarize"
  | "elaborate"
  | "rewrite";

/**
 * An instruction paired with content.
 */
export interface InstructionPair {
  /** Unique identifier */
  id: string;
  /** The instruction/prompt */
  instruction: string;
  /** The expected output (the actual content) */
  output: string;
  /** Type of instruction */
  type: InstructionType;
  /** Source chunk ID */
  chunkId: string;
  /** Source entry ID */
  entryId: string;
  /** Collection name */
  collection: string;
  /** Author (if available) */
  author?: string;
  /** Whether from an exemplary entry */
  isExemplary: boolean;
}

/**
 * Instruction templates for different types.
 */
const INSTRUCTION_TEMPLATES: Record<InstructionType, string[]> = {
  continue: [
    "Continue writing in the same style and voice.",
    "Write the next paragraph maintaining the established tone.",
    "Continue this piece of writing naturally.",
  ],
  write: [
    "Write a piece about: {topic}",
    "Compose content on the following topic: {topic}",
    "Create a written piece discussing: {topic}",
  ],
  explain: [
    "Explain {topic} in your writing style.",
    "Provide an explanation of {topic}.",
    "Write an explanation about {topic}.",
  ],
  summarize: [
    "Summarize the key points about {topic}.",
    "Write a concise summary about {topic}.",
    "Provide a brief overview of {topic}.",
  ],
  elaborate: [
    "Expand on the following idea: {topic}",
    "Provide more detail about: {topic}",
    "Elaborate on this concept: {topic}",
  ],
  rewrite: [
    "Rewrite this content while maintaining the core message.",
    "Express the same ideas in a different way.",
    "Rephrase this content while preserving the meaning.",
  ],
};

/**
 * Extract a topic from content for instruction generation.
 * Uses the first sentence or a portion of it.
 */
function extractTopic(content: string): string {
  // Get first sentence
  const firstSentenceMatch = content.match(/^[^.!?]+[.!?]/);
  if (firstSentenceMatch) {
    const sentence = firstSentenceMatch[0].trim();
    // Truncate if too long
    if (sentence.length > 100) {
      return sentence.slice(0, 97) + "...";
    }
    return sentence;
  }

  // Fallback: first 100 chars
  return content.slice(0, 100).trim() + (content.length > 100 ? "..." : "");
}

/**
 * Generate an instruction for a chunk.
 */
export function generateInstruction(
  chunk: ContentChunk,
  type: InstructionType = "write",
): InstructionPair {
  const templates = INSTRUCTION_TEMPLATES[type];
  const template =
    templates[Math.floor(Math.random() * templates.length)] ??
    templates[0] ??
    "Write about {topic}";

  const topic = extractTopic(chunk.text);
  const instruction = template.replace("{topic}", topic);

  const pair: InstructionPair = {
    id: `${chunk.id}:${type}`,
    instruction,
    output: chunk.text,
    type,
    chunkId: chunk.id,
    entryId: chunk.entryId,
    collection: chunk.collection,
    isExemplary: chunk.isExemplary,
  };
  if (chunk.author !== undefined) pair.author = chunk.author;
  return pair;
}

/**
 * Generate multiple instruction types for a chunk.
 */
export function generateInstructionsForChunk(
  chunk: ContentChunk,
  types: InstructionType[] = ["write", "explain", "elaborate"],
): InstructionPair[] {
  return types.map((type) => generateInstruction(chunk, type));
}

/**
 * Generate instructions for all chunks.
 */
export function generateInstructionsForChunks(
  chunks: ContentChunk[],
  types: InstructionType[] = ["write"],
): InstructionPair[] {
  return chunks.flatMap((chunk) => generateInstructionsForChunk(chunk, types));
}

// ============================================================================
// Training Pair Formatting
// ============================================================================

/**
 * A formatted training pair ready for fine-tuning.
 */
export interface TrainingPair {
  /** Unique identifier */
  id: string;
  /** The input prompt/instruction */
  input: string;
  /** The expected output */
  output: string;
  /** Metadata for filtering/analysis */
  metadata: {
    entryId: string;
    collection: string;
    author?: string;
    type: InstructionType;
    isExemplary: boolean;
    wordCount: number;
  };
}

/**
 * Format an instruction pair as a training pair.
 */
export function formatTrainingPair(pair: InstructionPair): TrainingPair {
  const metadata: TrainingPair["metadata"] = {
    entryId: pair.entryId,
    collection: pair.collection,
    type: pair.type,
    isExemplary: pair.isExemplary,
    wordCount: countWords(pair.output),
  };
  if (pair.author !== undefined) metadata.author = pair.author;

  return {
    id: pair.id,
    input: pair.instruction,
    output: pair.output,
    metadata,
  };
}

/**
 * Format multiple instruction pairs as training pairs.
 */
export function formatTrainingPairs(pairs: InstructionPair[]): TrainingPair[] {
  return pairs.map(formatTrainingPair);
}

/**
 * Options for training data generation.
 */
export interface TrainingDataOptions extends ChunkingOptions {
  /** Instruction types to generate */
  instructionTypes?: InstructionType[];
  /** Whether to prioritize exemplary content (give it more weight) */
  prioritizeExemplary?: boolean;
  /** Multiplier for exemplary content (how many times to include it) */
  exemplaryMultiplier?: number;
}

/**
 * Default training data options.
 */
const DEFAULT_TRAINING_DATA_OPTIONS: Required<TrainingDataOptions> = {
  ...DEFAULT_CHUNKING_OPTIONS,
  instructionTypes: ["write"],
  prioritizeExemplary: true,
  exemplaryMultiplier: 2,
};

/**
 * Generate training data from voice samples.
 * This is the main entry point for preparing training datasets.
 */
export function generateTrainingData(
  samples: VoiceSample[],
  options: TrainingDataOptions = {},
): TrainingPair[] {
  const opts = { ...DEFAULT_TRAINING_DATA_OPTIONS, ...options };
  const { instructionTypes, prioritizeExemplary, exemplaryMultiplier } = opts;

  // Chunk all samples
  const chunks = chunkVoiceSamples(samples, opts);

  // Generate instructions
  let instructions = generateInstructionsForChunks(chunks, instructionTypes);

  // Optionally duplicate exemplary content
  if (prioritizeExemplary && exemplaryMultiplier > 1) {
    const exemplaryInstructions = instructions.filter((i) => i.isExemplary);
    for (let i = 1; i < exemplaryMultiplier; i++) {
      instructions = instructions.concat(
        exemplaryInstructions.map((inst) => Object.assign({}, inst, { id: `${inst.id}:dup:${i}` })),
      );
    }
  }

  // Format as training pairs
  return formatTrainingPairs(instructions);
}

// ============================================================================
// Export Formats
// ============================================================================

/**
 * JSONL format for training data export.
 */
export interface JSONLExportOptions {
  /** Include metadata in export */
  includeMetadata?: boolean;
}

/**
 * Export training pairs as JSONL string.
 * Each line is a JSON object with instruction/output.
 */
export function exportAsJSONL(pairs: TrainingPair[], options: JSONLExportOptions = {}): string {
  const { includeMetadata = false } = options;

  return pairs
    .map((pair) => {
      const obj: Record<string, unknown> = {
        instruction: pair.input,
        output: pair.output,
      };
      if (includeMetadata) {
        obj["metadata"] = pair.metadata;
      }
      return JSON.stringify(obj);
    })
    .join("\n");
}

/**
 * Alpaca format for fine-tuning.
 * Standard format used by many fine-tuning tools.
 */
export interface AlpacaEntry {
  instruction: string;
  input: string;
  output: string;
}

/**
 * Export training pairs in Alpaca format.
 */
export function exportAsAlpaca(pairs: TrainingPair[]): AlpacaEntry[] {
  return pairs.map((pair) => ({
    instruction: pair.input,
    input: "", // Alpaca uses empty input for single-turn
    output: pair.output,
  }));
}

/**
 * Export training pairs as Alpaca JSON string.
 */
export function exportAsAlpacaJSON(pairs: TrainingPair[]): string {
  return JSON.stringify(exportAsAlpaca(pairs), null, 2);
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Statistics about generated training data.
 */
export interface TrainingDataStats {
  /** Total number of training pairs */
  totalPairs: number;
  /** Total word count across all outputs */
  totalWords: number;
  /** Average words per output */
  averageWords: number;
  /** Number of exemplary pairs */
  exemplaryPairs: number;
  /** Breakdown by instruction type */
  byType: Record<InstructionType, number>;
  /** Breakdown by collection */
  byCollection: Record<string, number>;
  /** Breakdown by author (if available) */
  byAuthor: Record<string, number>;
}

/**
 * Calculate statistics for training data.
 */
export function calculateTrainingStats(pairs: TrainingPair[]): TrainingDataStats {
  // Use reduce with mutable accumulator for O(n) performance on large datasets
  const stats = pairs.reduce<{
    totalWords: number;
    exemplaryPairs: number;
    byType: Record<InstructionType, number>;
    byCollection: Record<string, number>;
    byAuthor: Record<string, number>;
  }>(
    (acc, pair) => {
      acc.totalWords += pair.metadata.wordCount;
      if (pair.metadata.isExemplary) acc.exemplaryPairs++;
      acc.byType[pair.metadata.type]++;
      acc.byCollection[pair.metadata.collection] =
        (acc.byCollection[pair.metadata.collection] || 0) + 1;
      if (pair.metadata.author) {
        acc.byAuthor[pair.metadata.author] = (acc.byAuthor[pair.metadata.author] || 0) + 1;
      }
      return acc;
    },
    {
      totalWords: 0,
      exemplaryPairs: 0,
      byType: { continue: 0, write: 0, explain: 0, summarize: 0, elaborate: 0, rewrite: 0 },
      byCollection: {},
      byAuthor: {},
    },
  );

  return {
    totalPairs: pairs.length,
    totalWords: stats.totalWords,
    averageWords: pairs.length > 0 ? Math.round(stats.totalWords / pairs.length) : 0,
    exemplaryPairs: stats.exemplaryPairs,
    byType: stats.byType,
    byCollection: stats.byCollection,
    byAuthor: stats.byAuthor,
  };
}
