/**
 * Build-time embedding generation using transformers.js
 *
 * Generates embeddings for content entries using the all-MiniLM-L6-v2 model.
 * Embeddings are 384-dimensional vectors used for semantic search.
 */

import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { createSingletonLoader } from "@keel/content-shared/mutex";
import { DocksError } from "@keel/content-shared/errors";
import type {
  SearchableEntry,
  EmbeddingResult,
  GenerateEmbeddingsOptions,
} from "./types";
import {
  MODEL_NAME,
  DEFAULT_MAX_TEXT_LENGTH,
  DEFAULT_SNIPPET_LENGTH,
} from "./constants";

// ============================================================================
// Embedder
// ============================================================================

/** Module-level pipeline instance */
let embeddingPipeline: FeatureExtractionPipeline | null = null;

/**
 * Singleton loader for the embedding pipeline.
 * Uses createSingletonLoader to prevent race conditions during initialization.
 */
const loadPipeline = createSingletonLoader(async () => {
  try {
    const p = await pipeline("feature-extraction", MODEL_NAME, {
      dtype: "fp32",
    });
    embeddingPipeline = p;
    return embeddingPipeline;
  } catch (error) {
    throw new DocksError(
      `Failed to load embedding model: ${error instanceof Error ? error.message : String(error)}`,
      "EMBEDDING_MODEL_ERROR",
      { model: MODEL_NAME }
    );
  }
});

/**
 * Get the embedding pipeline, loading it if necessary.
 */
async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  return loadPipeline();
}

/**
 * Generate embedding for text, validating the result structure.
 */
async function generateEmbeddingInternal(text: string): Promise<number[]> {
  const embed = await getEmbedder();
  const result = await embed(text, { pooling: "mean", normalize: true });

  // Validate result structure before casting
  if (!result || !("data" in result)) {
    throw new DocksError(
      "Embedding model returned invalid result structure",
      "EMBEDDING_RESULT_ERROR",
      { hasData: "data" in (result ?? {}) }
    );
  }

  const data = result.data;
  if (!(data instanceof Float32Array)) {
    throw new DocksError(
      "Embedding model returned non-Float32Array data",
      "EMBEDDING_RESULT_ERROR",
      { dataType: data?.constructor?.name ?? typeof data }
    );
  }

  return Array.from(data);
}

// ============================================================================
// Text Processing
// ============================================================================

/**
 * Strip markdown/HTML formatting for cleaner text.
 * Used for embedding generation and snippet extraction.
 */
export function stripMarkdown(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, "") // Remove code blocks
    .replace(/`[^`]+`/g, "") // Remove inline code
    .replace(/<[^>]+>/g, "") // Remove HTML tags
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Convert links to text
    .replace(/^#+\s+/gm, "") // Remove heading markers
    .replace(/[*_~]+/g, "") // Remove emphasis markers
    .replace(/\n+/g, " ") // Collapse newlines
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Generate embedding for a single text string.
 * Uses all-MiniLM-L6-v2 model (384 dimensions).
 *
 * @param text - Text to embed
 * @returns 384-dimensional normalized embedding vector
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  return generateEmbeddingInternal(text);
}

/**
 * Prepare text for embedding from an entry.
 * Combines title and content, truncates to maxLength.
 */
function prepareText(entry: SearchableEntry, maxLength: number): string {
  const title = typeof entry["title"] === "string" ? entry["title"] : "";
  const content = typeof entry["content"] === "string" ? entry["content"] : "";
  const cleanContent = stripMarkdown(content);
  const combined = title ? `${title}\n\n${cleanContent}` : cleanContent;
  return combined.slice(0, maxLength);
}

/**
 * Extract a snippet from content for search results display.
 */
function extractSnippet(entry: SearchableEntry, length: number): string {
  const content = typeof entry["content"] === "string" ? entry["content"] : "";
  const clean = stripMarkdown(content);

  if (clean.length <= length) return clean;

  // Cut at word boundary
  const cut = clean.slice(0, length);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > length * 0.8
    ? cut.slice(0, lastSpace) + "..."
    : cut + "...";
}

/**
 * Generate embeddings for multiple entries.
 * Processes entries sequentially to avoid memory issues.
 *
 * @param entries - Content entries to embed
 * @param options - Generation options
 * @returns Array of embedding results
 */
export async function generateEmbeddings(
  entries: SearchableEntry[],
  options: GenerateEmbeddingsOptions = {}
): Promise<EmbeddingResult[]> {
  const {
    onProgress,
    maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
    snippetLength = DEFAULT_SNIPPET_LENGTH,
  } = options;

  // Filter entries that have required fields
  const validEntries: SearchableEntry[] = [];
  const skippedEntries: Array<{ index: number; reason: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const missingFields: string[] = [];

    if (typeof e["id"] !== "string") missingFields.push("id");
    if (typeof e["slug"] !== "string") missingFields.push("slug");
    if (typeof e["collection"] !== "string") missingFields.push("collection");

    if (missingFields.length === 0) {
      validEntries.push(e);
    } else {
      skippedEntries.push({
        index: i,
        reason: `missing or invalid fields: ${missingFields.join(", ")}`,
      });
    }
  }

  // Log warning if entries were filtered
  if (skippedEntries.length > 0) {
    console.warn(
      `[embeddings] Skipped ${skippedEntries.length} entries due to missing required fields:`
    );
    for (const { index, reason } of skippedEntries.slice(0, 5)) {
      console.warn(`  - Entry at index ${index}: ${reason}`);
    }
    if (skippedEntries.length > 5) {
      console.warn(`  ... and ${skippedEntries.length - 5} more`);
    }
  }

  const results: EmbeddingResult[] = [];

  for (let i = 0; i < validEntries.length; i++) {
    const entry = validEntries[i]!;

    onProgress?.({
      current: i + 1,
      total: validEntries.length,
      entry: String(entry["title"] ?? entry["slug"]),
    });

    const text = prepareText(entry, maxTextLength);
    const embedding = await generateEmbedding(text);

    results.push({
      id: entry["id"] as string,
      slug: entry["slug"] as string,
      collection: entry["collection"] as string,
      title:
        typeof entry["title"] === "string"
          ? entry["title"]
          : (entry["slug"] as string),
      snippet: extractSnippet(entry, snippetLength),
      embedding,
    });
  }

  return results;
}

/**
 * Dispose of the embedder to free memory.
 * Call this after generating embeddings if the process is long-running.
 *
 * NOTE: This nullifies references but does not fully release WASM memory
 * used by transformers.js. Full memory release requires process termination.
 */
export function disposeEmbedder(): void {
  embeddingPipeline = null;
}
