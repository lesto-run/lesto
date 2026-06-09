import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import type { AnyCollection, RuntimeEntry, VoiceConfig, GlobalVoiceConfig, TerminologyEntry } from "./types";
import { hashString } from "./cache/hash";

const VOICE_SAMPLES_DIR = ".docks/voice-samples";
const VOICE_CACHE_DIR = ".docks/voice-cache";

// ============================================================================
// Content Cleaning - Remove code blocks while preserving prose style
// ============================================================================

/**
 * Strip code blocks from content for voice profile analysis.
 * Code blocks contain non-natural-language content (function names, syntax)
 * that pollutes voice analysis. This preserves other markdown formatting
 * that reflects writing style (headings, emphasis, lists).
 */
export function stripCodeBlocks(content: string): string {
  return content
    // Remove fenced code blocks (```...``` or ~~~...~~~)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    // Remove inline code (`...`)
    .replace(/`[^`\n]+`/g, "")
    // Collapse multiple newlines to at most two
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================================================
// Validation Schemas - Runtime validation for JSON data
// ============================================================================

/**
 * Zod schema for VoiceSample.
 * Used to validate data read from cache files.
 */
const VoiceSampleSchema = z.object({
  entryId: z.string(),
  collection: z.string(),
  author: z.string().optional(),
  content: z.string(),
  title: z.string().optional(),
  isExemplary: z.boolean(),
  // Date can be a string (ISO format) or will be parsed
  date: z.union([z.string(), z.date()]).optional().transform((val) => {
    if (!val) return undefined;
    if (val instanceof Date) return val;
    const parsed = new Date(val);
    return isNaN(parsed.getTime()) ? undefined : parsed;
  }),
});

const VoiceSamplesArraySchema = z.array(VoiceSampleSchema);

/** Build a {@link VoiceSample} from a validated schema sample, omitting absent optional fields. */
function toVoiceSample(sample: z.infer<typeof VoiceSampleSchema>): VoiceSample {
  const result: VoiceSample = {
    entryId: sample.entryId,
    collection: sample.collection,
    content: sample.content,
    isExemplary: sample.isExemplary,
  };
  if (sample.author !== undefined) {
    result.author = sample.author;
  }
  if (sample.title !== undefined) {
    result.title = sample.title;
  }
  if (sample.date !== undefined) {
    result.date = sample.date;
  }
  return result;
}

/**
 * Zod schema for VoiceCacheMetadata.
 */
const VoiceCacheMetadataSchema = z.object({
  contentHash: z.string(),
  createdAt: z.string(),
  sampleCount: z.number().int().nonnegative(),
  author: z.string().optional(),
});

/**
 * Zod schema for CachedVoiceProfile.
 */
const CachedVoiceProfileSchema = z.object({
  metadata: VoiceCacheMetadataSchema,
  samples: VoiceSamplesArraySchema,
});

/**
 * Safely parse JSON as VoiceSample array with validation.
 * Returns null if parsing or validation fails.
 */
function parseVoiceSamples(content: string): VoiceSample[] | null {
  try {
    const json = JSON.parse(content);
    const result = VoiceSamplesArraySchema.safeParse(json);
    if (!result.success) {
      console.warn("[Voice] Invalid voice samples format:", result.error.message);
      return null;
    }
    // Map validated data to VoiceSample type
    return result.data.map((sample) => toVoiceSample(sample));
  } catch (error) {
    console.warn("[Voice] Failed to parse voice samples JSON:", error);
    return null;
  }
}

/**
 * Safely parse JSON as CachedVoiceProfile with validation.
 * Returns null if parsing or validation fails.
 */
function parseCachedVoiceProfile(content: string): CachedVoiceProfile | null {
  try {
    const json = JSON.parse(content);
    const result = CachedVoiceProfileSchema.safeParse(json);
    if (!result.success) {
      console.warn("[Voice] Invalid cached voice profile format:", result.error.message);
      return null;
    }
    // Map validated data to CachedVoiceProfile type
    const { metadata, samples } = result.data;
    return {
      metadata: {
        contentHash: metadata.contentHash,
        createdAt: metadata.createdAt,
        sampleCount: metadata.sampleCount,
        ...(metadata.author !== undefined && { author: metadata.author }),
      },
      samples: samples.map((sample) => toVoiceSample(sample)),
    };
  } catch (error) {
    console.warn("[Voice] Failed to parse cached voice profile JSON:", error);
    return null;
  }
}

// ============================================================================
// Path Security - Prevent path traversal attacks
// ============================================================================

/**
 * Error thrown when a path traversal attack is detected.
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}

/**
 * Sanitize a path segment to prevent directory traversal attacks.
 * Removes path separators, null bytes, and leading dots.
 * @throws {PathTraversalError} if the input is malicious or results in an empty string
 */
export function sanitizePathSegment(segment: string): string {
  if (!segment || typeof segment !== "string") {
    throw new PathTraversalError("Path segment cannot be empty");
  }

  // Sanitize in one immutable chain - per AGENTS.md
  // 1. Remove null bytes (can bypass some checks)
  // 2. Remove path separators (/, \) and colons (Windows drive letters)
  // 3. Remove leading dots to prevent ../ traversal and hidden files
  // 4. Remove any remaining .. sequences that might have formed
  // 5. Trim whitespace
  const sanitized = segment
    .replaceAll("\u0000", "")
    .replace(/[/\\:]/g, "")
    .replace(/^\.+/, "")
    .replace(/\.\./g, "")
    .trim();

  // Check if we have a valid result
  if (!sanitized || sanitized === "" || /^_*$/.test(sanitized)) {
    throw new PathTraversalError(`Invalid path segment: "${segment}" sanitizes to empty or invalid value`);
  }

  return sanitized;
}

/**
 * Validate that a resolved path is within the expected base directory.
 * Uses path normalization to handle any remaining edge cases.
 * @throws {PathTraversalError} if the path escapes the base directory
 */
export function validatePathWithinBase(resolvedPath: string, basePath: string): void {
  // Normalize both paths to handle any edge cases
  const normalizedResolved = path.normalize(resolvedPath);
  const normalizedBase = path.normalize(basePath);

  // Ensure the resolved path starts with the base path
  // We add a separator to prevent matching /base-other when base is /base
  if (!normalizedResolved.startsWith(normalizedBase + path.sep) && normalizedResolved !== normalizedBase) {
    throw new PathTraversalError(
      `Path "${resolvedPath}" escapes base directory "${basePath}"`
    );
  }
}

// ============================================================================
// PathContext - Centralized path building with security
// ============================================================================

/**
 * PathContext provides centralized path building for voice-related files.
 * Handles sanitization and validation to prevent path traversal attacks.
 */
export class PathContext {
  private readonly baseDir: string;

  constructor(cwd: string, baseSubdir: string) {
    this.baseDir = path.join(cwd, baseSubdir);
  }

  /**
   * Get the base directory path.
   */
  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * Get the file path for a collection/author combination.
   * @throws {PathTraversalError} if collection or author contain malicious characters
   */
  getFilePath(collection: string, author?: string, defaultFile = "_collection.json"): string {
    const safeCollection = sanitizePathSegment(collection);
    const basePath = path.join(this.baseDir, safeCollection);

    const filePath = author
      ? path.join(basePath, `${sanitizePathSegment(author)}.json`)
      : path.join(basePath, defaultFile);

    validatePathWithinBase(filePath, this.baseDir);
    return filePath;
  }

  /**
   * Get the directory path for a collection.
   * @throws {PathTraversalError} if collection contains malicious characters
   */
  getDirPath(collection: string): string {
    const safeCollection = sanitizePathSegment(collection);
    const dir = path.join(this.baseDir, safeCollection);
    validatePathWithinBase(dir, this.baseDir);
    return dir;
  }
}

/**
 * Voice sample containing content from an entry for voice profile building.
 */
export interface VoiceSample {
  /** Unique identifier for the entry */
  entryId: string;
  /** Collection the entry belongs to */
  collection: string;
  /** Author of the content (if perAuthor is enabled) */
  author?: string;
  /** The raw content of the entry */
  content: string;
  /** Title of the entry (if available) */
  title?: string;
  /** Whether this entry is marked as exemplary */
  isExemplary: boolean;
  /** Date the entry was created/published (for recency sorting) */
  date?: Date;
}

/**
 * Voice context containing samples and configuration for prompt generation.
 */
export interface VoiceContext {
  /** Collection name */
  collection: string;
  /** Author name (if per-author profiles are enabled) */
  author?: string;
  /** Sampled content for voice profile */
  samples: VoiceSample[];
  /** Organization-wide terminology mappings */
  terminology: TerminologyEntry[];
}

/**
 * Default configuration values for voice sampling.
 */
const DEFAULT_VOICE_CONFIG: Required<Omit<VoiceConfig, "perAuthor">> & { perAuthor: boolean } = {
  perAuthor: false,
  limit: 10,
  minEntries: 3,
  authorField: "author",
  exemplaryField: "voiceModel",
  training: {
    minWords: 250,
    maxWords: 650,
    targetWords: 400,
    instructionTypes: ["write"],
    prioritizeExemplary: true,
    exemplaryMultiplier: 2,
    outputFormat: "jsonl",
  },
};

/**
 * Get the resolved voice config with defaults applied.
 */
export function resolveVoiceConfig(config?: VoiceConfig): Required<Omit<VoiceConfig, "perAuthor">> & { perAuthor: boolean } {
  if (!config) return DEFAULT_VOICE_CONFIG;
  return {
    perAuthor: config.perAuthor ?? DEFAULT_VOICE_CONFIG.perAuthor,
    limit: config.limit ?? DEFAULT_VOICE_CONFIG.limit,
    minEntries: config.minEntries ?? DEFAULT_VOICE_CONFIG.minEntries,
    authorField: config.authorField ?? DEFAULT_VOICE_CONFIG.authorField,
    exemplaryField: config.exemplaryField ?? DEFAULT_VOICE_CONFIG.exemplaryField,
    training: config.training ?? DEFAULT_VOICE_CONFIG.training,
  };
}

/**
 * Extract a date from an entry using common date field names.
 */
function extractDate(entry: RuntimeEntry): Date | undefined {
  const dateFields = ["date", "publishedAt", "createdAt", "published", "created"];
  for (const field of dateFields) {
    const value = entry[field];
    if (value instanceof Date) return value;
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return parsed;
    }
  }
  return undefined;
}

/**
 * Sample entries from a collection for voice profile building.
 * Prioritizes exemplary entries, then sorts by recency.
 */
export function sampleEntries(
  entries: RuntimeEntry[],
  collection: AnyCollection,
): VoiceSample[] {
  const config = resolveVoiceConfig(collection.voice);

  // Not enough entries to build a profile
  if (entries.length < config.minEntries) {
    return [];
  }

  // Extract samples with metadata
  const samples: VoiceSample[] = entries.map((entry) => {
    const author = config.perAuthor ? String(entry[config.authorField] ?? "") : undefined;
    const rawContent = typeof entry["content"] === "string" ? entry["content"] : "";
    // Strip code blocks to focus on natural language prose for voice analysis
    const content = stripCodeBlocks(rawContent);
    const title = typeof entry["title"] === "string" ? entry["title"] : undefined;
    const date = extractDate(entry);

    const sample: VoiceSample = {
      entryId: entry.id,
      collection: collection.name,
      content,
      isExemplary: Boolean(entry[config.exemplaryField]),
    };

    // Only add optional properties if they have values
    if (author !== undefined) sample.author = author;
    if (title !== undefined) sample.title = title;
    if (date !== undefined) sample.date = date;

    return sample;
  });

  // Sort: exemplary first, then by date (newest first)
  samples.sort((a, b) => {
    // Exemplary entries come first
    if (a.isExemplary && !b.isExemplary) return -1;
    if (!a.isExemplary && b.isExemplary) return 1;

    // Then sort by date (newest first)
    if (a.date && b.date) {
      return b.date.getTime() - a.date.getTime();
    }
    if (a.date) return -1;
    if (b.date) return 1;

    return 0;
  });

  // Take the configured limit
  return samples.slice(0, config.limit);
}

/**
 * Sample entries grouped by author.
 * Returns a map of author -> samples.
 */
export function sampleEntriesByAuthor(
  entries: RuntimeEntry[],
  collection: AnyCollection,
): Map<string, VoiceSample[]> {
  const config = resolveVoiceConfig(collection.voice);

  // Group entries by author
  const byAuthor = new Map<string, RuntimeEntry[]>();
  for (const entry of entries) {
    const author = String(entry[config.authorField] ?? "unknown");
    const authorEntries = byAuthor.get(author) ?? [];
    authorEntries.push(entry);
    byAuthor.set(author, authorEntries);
  }

  // Sample from each author
  const result = new Map<string, VoiceSample[]>();
  for (const [author, authorEntries] of byAuthor) {
    const samples = sampleEntries(authorEntries, collection);
    if (samples.length > 0) {
      result.set(author, samples);
    }
  }

  return result;
}

/**
 * Get the path to the voice samples directory for a collection.
 * @throws {PathTraversalError} if collection or author contain malicious characters
 */
export function getVoiceSamplesPath(cwd: string, collection: string, author?: string): string {
  const voiceSamples = new PathContext(cwd, VOICE_SAMPLES_DIR);
  return voiceSamples.getFilePath(collection, author);
}

/**
 * Write voice samples to disk.
 */
export async function writeVoiceSamples(
  cwd: string,
  collection: string,
  samples: VoiceSample[],
  author?: string,
): Promise<void> {
  const filePath = getVoiceSamplesPath(cwd, collection, author);
  const dir = path.dirname(filePath);

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(samples, null, 2), "utf-8");
}

/**
 * Read voice samples from disk.
 */
export async function readVoiceSamples(
  cwd: string,
  collection: string,
  author?: string,
): Promise<VoiceSample[] | null> {
  const filePath = getVoiceSamplesPath(cwd, collection, author);

  try {
    const content = await readFile(filePath, "utf-8");
    return parseVoiceSamples(content);
  } catch {
    return null;
  }
}

/**
 * List all authors with voice samples for a collection.
 * @throws {PathTraversalError} if collection contains malicious characters
 */
export async function listVoiceSampleAuthors(
  cwd: string,
  collection: string,
): Promise<string[]> {
  const voiceSamples = new PathContext(cwd, VOICE_SAMPLES_DIR);
  const dir = voiceSamples.getDirPath(collection);

  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".json") && f !== "_collection.json")
      .map((f) => f.replace(".json", ""));
  } catch {
    return [];
  }
}

/**
 * Build voice context for AI prompt generation.
 */
export function buildVoiceContext(
  collection: string,
  samples: VoiceSample[],
  globalConfig?: GlobalVoiceConfig,
  author?: string,
): VoiceContext {
  const context: VoiceContext = {
    collection,
    samples,
    terminology: globalConfig?.terminology ?? [],
  };
  if (author !== undefined) {
    context.author = author;
  }
  return context;
}

/**
 * Build a prompt section containing example content for voice learning.
 * This includes the raw content from samples so the LLM can naturally infer the writing style.
 */
export function buildVoiceExamplesPrompt(context: VoiceContext): string {
  if (context.samples.length === 0) {
    return "";
  }

  const lines: string[] = [];

  // Header
  if (context.author) {
    lines.push(`## Writing Style Examples from ${context.author}`);
    lines.push("");
    lines.push(`The following are examples of ${context.author}'s writing. Study these carefully to understand their unique voice, tone, style, and word choices. When generating content, write exactly as this author would - matching their sentence structure, vocabulary, rhythm, and personality.`);
  } else {
    lines.push(`## Writing Style Examples from the "${context.collection}" collection`);
    lines.push("");
    lines.push(`The following are examples of content from this collection. Study these carefully to understand the writing style, tone, and voice used. When generating content, match this style exactly.`);
  }

  lines.push("");

  // Add each sample
  for (const [index, sample] of context.samples.entries()) {
    const exemplaryNote = sample.isExemplary ? " (exemplary)" : "";
    const title = sample.title || `Example ${index + 1}`;

    lines.push(`### ${title}${exemplaryNote}`);
    lines.push("");
    lines.push(sample.content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Build a prompt section for terminology rules.
 * Instructs the AI to use preferred terms instead of incorrect ones.
 */
export function buildTerminologyPrompt(terminology: TerminologyEntry[]): string {
  if (terminology.length === 0) {
    return "";
  }

  const lines: string[] = [];

  lines.push("## Terminology Guidelines");
  lines.push("");
  lines.push("Use the preferred terms in your writing. Avoid the incorrect terms listed below:");
  lines.push("");

  for (const entry of terminology) {
    const reason = entry.reason ? ` (${entry.reason})` : "";
    lines.push(`- Use "${entry.preferred}" instead of "${entry.incorrect}"${reason}`);
  }

  lines.push("");

  return lines.join("\n");
}

/**
 * Build the complete voice prompt from a voice context.
 * Combines example content and terminology rules.
 */
export function buildVoicePrompt(context: VoiceContext): string {
  const parts: string[] = [];

  // Add terminology guidelines first
  const terminologyPrompt = buildTerminologyPrompt(context.terminology);
  if (terminologyPrompt) {
    parts.push(terminologyPrompt);
  }

  // Add example content
  const examplesPrompt = buildVoiceExamplesPrompt(context);
  if (examplesPrompt) {
    parts.push(examplesPrompt);
  }

  return parts.join("\n");
}

/**
 * Options for building a voice system prompt.
 */
export interface VoiceSystemPromptOptions {
  /** Whether to include a preamble explaining the voice system */
  includePreamble?: boolean;
  /** Custom preamble text to use instead of the default */
  customPreamble?: string;
  /** Whether to include instructions for the AI */
  includeInstructions?: boolean;
  /** Custom instructions to append */
  customInstructions?: string;
}

const DEFAULT_PREAMBLE = `# Writing Voice Guide

You are a writing assistant that matches a specific voice and style. Follow the guidelines and examples below to ensure your writing is consistent with the established voice.`;

const DEFAULT_INSTRUCTIONS = `## Important Instructions

1. **Match the voice exactly**: Your writing should be indistinguishable from the examples provided.
2. **Use the correct terminology**: Always use the preferred terms from the terminology guidelines.
3. **Maintain consistency**: Every piece of content you write should feel like it comes from the same author/organization.
4. **Don't add your own style**: Suppress your default writing tendencies and adopt the demonstrated style completely.
5. **Preserve authenticity**: The goal is to write AS the author, not FOR the author.`;

/**
 * Build a complete system prompt for voice-matched AI content generation.
 * This includes organization guardrails, terminology, and author/collection voice examples.
 */
export function buildVoiceSystemPrompt(
  context: VoiceContext,
  options: VoiceSystemPromptOptions = {},
): string {
  const {
    includePreamble = true,
    customPreamble,
    includeInstructions = true,
    customInstructions,
  } = options;

  const parts: string[] = [];

  // Add preamble
  if (includePreamble) {
    parts.push(customPreamble ?? DEFAULT_PREAMBLE);
    parts.push("");
  }

  // Add the voice prompt (terminology + examples)
  const voicePrompt = buildVoicePrompt(context);
  if (voicePrompt) {
    parts.push(voicePrompt);
  }

  // Add instructions
  if (includeInstructions) {
    parts.push(customInstructions ?? DEFAULT_INSTRUCTIONS);
    parts.push("");
  }

  // Add context summary
  if (context.author) {
    parts.push(`You are writing as **${context.author}** for the "${context.collection}" collection.`);
  } else {
    parts.push(`You are writing for the "${context.collection}" collection.`);
  }

  return parts.join("\n");
}

/**
 * Build a voice system prompt from stored samples.
 * Convenience function that reads samples from disk and builds the prompt.
 */
export async function buildVoiceSystemPromptFromSamples(
  cwd: string,
  collection: string,
  globalConfig?: GlobalVoiceConfig,
  author?: string,
  options?: VoiceSystemPromptOptions,
): Promise<string | null> {
  const samples = await readVoiceSamples(cwd, collection, author);

  if (!samples || samples.length === 0) {
    return null;
  }

  const context = buildVoiceContext(collection, samples, globalConfig, author);
  return buildVoiceSystemPrompt(context, options);
}

// ============================================================================
// Caching
// ============================================================================

/**
 * Cache metadata stored alongside voice profiles.
 */
export interface VoiceCacheMetadata {
  /** Hash of the entry IDs and content used to generate the profile */
  contentHash: string;
  /** Timestamp when the cache was created */
  createdAt: string;
  /** Number of samples used */
  sampleCount: number;
  /** Author (if per-author) */
  author?: string;
}

/**
 * Cached voice profile containing samples and metadata.
 */
export interface CachedVoiceProfile {
  metadata: VoiceCacheMetadata;
  samples: VoiceSample[];
}

/**
 * Get the path to the voice cache file.
 * @throws {PathTraversalError} if collection or author contain malicious characters
 */
export function getVoiceCachePath(cwd: string, collection: string, author?: string): string {
  const voiceCache = new PathContext(cwd, VOICE_CACHE_DIR);
  return voiceCache.getFilePath(collection, author);
}

/**
 * Compute a hash of the entry content for cache invalidation.
 */
export async function computeContentHash(entries: RuntimeEntry[]): Promise<string> {
  // Create a deterministic string from entry IDs and content
  const contentParts = entries
    .map((e) => `${e.id}:${typeof e["content"] === "string" ? e["content"] : ""}`)
    .toSorted()
    .join("\n");

  return hashString(contentParts);
}

/**
 * Read a cached voice profile.
 */
export async function readCachedVoiceProfile(
  cwd: string,
  collection: string,
  author?: string,
): Promise<CachedVoiceProfile | null> {
  const filePath = getVoiceCachePath(cwd, collection, author);

  try {
    const content = await readFile(filePath, "utf-8");
    return parseCachedVoiceProfile(content);
  } catch {
    return null;
  }
}

/**
 * Write a voice profile to the cache.
 */
export async function writeCachedVoiceProfile(
  cwd: string,
  collection: string,
  samples: VoiceSample[],
  contentHash: string,
  author?: string,
): Promise<void> {
  const filePath = getVoiceCachePath(cwd, collection, author);
  const dir = path.dirname(filePath);

  const metadata: VoiceCacheMetadata = {
    contentHash,
    createdAt: new Date().toISOString(),
    sampleCount: samples.length,
  };
  if (author !== undefined) {
    metadata.author = author;
  }

  const profile: CachedVoiceProfile = {
    metadata,
    samples,
  };

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(profile, null, 2), "utf-8");
}

/**
 * Check if the cache is still valid for the given entries.
 */
export async function isCacheValid(
  cwd: string,
  collection: string,
  entries: RuntimeEntry[],
  author?: string,
): Promise<boolean> {
  const cached = await readCachedVoiceProfile(cwd, collection, author);
  if (!cached) return false;

  const currentHash = await computeContentHash(entries);
  return cached.metadata.contentHash === currentHash;
}

/**
 * Get voice samples, using cache if available and valid.
 * Regenerates and caches if content has changed.
 */
export async function getVoiceSamplesWithCache(
  cwd: string,
  entries: RuntimeEntry[],
  collection: AnyCollection,
  author?: string,
): Promise<VoiceSample[]> {
  const config = resolveVoiceConfig(collection.voice);

  // Filter entries by author if needed
  const relevantEntries = author
    ? entries.filter((e) => String(e[config.authorField] ?? "") === author)
    : entries;

  // Check if we have a valid cache
  const cached = await readCachedVoiceProfile(cwd, collection.name, author);
  if (cached) {
    const currentHash = await computeContentHash(relevantEntries);
    if (cached.metadata.contentHash === currentHash) {
      return cached.samples;
    }
  }

  // Generate new samples
  const samples = sampleEntries(relevantEntries, collection);

  // Cache the results
  if (samples.length > 0) {
    const contentHash = await computeContentHash(relevantEntries);
    await writeCachedVoiceProfile(cwd, collection.name, samples, contentHash, author);
  }

  return samples;
}

/**
 * Invalidate the voice cache for a collection or author.
 */
export async function invalidateVoiceCache(
  cwd: string,
  collection: string,
  author?: string,
): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  const filePath = getVoiceCachePath(cwd, collection, author);

  try {
    await unlink(filePath);
  } catch {
    // File doesn't exist, nothing to invalidate
  }
}

/**
 * Invalidate all voice caches for a collection.
 * @throws {PathTraversalError} if collection contains malicious characters
 */
export async function invalidateAllVoiceCaches(
  cwd: string,
  collection: string,
): Promise<void> {
  const voiceCache = new PathContext(cwd, VOICE_CACHE_DIR);
  const dir = voiceCache.getDirPath(collection);
  const { rm } = await import("node:fs/promises");

  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Directory doesn't exist, nothing to invalidate
  }
}

/**
 * Get cache statistics for a collection.
 * @throws {PathTraversalError} if collection contains malicious characters
 */
export async function getVoiceCacheStats(
  cwd: string,
  collection: string,
): Promise<{
  exists: boolean;
  authors: string[];
  hasCollectionProfile: boolean;
  totalSamples: number;
}> {
  const voiceCache = new PathContext(cwd, VOICE_CACHE_DIR);
  const dir = voiceCache.getDirPath(collection);

  try {
    const files = await readdir(dir);
    const authors = files
      .filter((f) => f.endsWith(".json") && f !== "_collection.json")
      .map((f) => f.replace(".json", ""));

    // Count samples in each profile (parallel reads, sum results)
    const sampleCounts = await Promise.all(
      files.map(async (file) => {
        try {
          const content = await readFile(path.join(dir, file), "utf-8");
          const profile = parseCachedVoiceProfile(content);
          return profile?.metadata.sampleCount ?? 0;
        } catch {
          return 0; // Skip invalid files
        }
      })
    );
    const totalSamples = sampleCounts.reduce((sum, count) => sum + count, 0);

    return {
      exists: true,
      authors,
      hasCollectionProfile: files.includes("_collection.json"),
      totalSamples,
    };
  } catch {
    return {
      exists: false,
      authors: [],
      hasCollectionProfile: false,
      totalSamples: 0,
    };
  }
}
