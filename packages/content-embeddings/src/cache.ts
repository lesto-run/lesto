/**
 * Embedding Cache for Incremental Updates
 *
 * Caches embeddings keyed by content hash to avoid re-generating
 * embeddings for unchanged content.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { DocksError } from "@keel/content-shared/errors";
import type {
  SearchableEntry,
  EmbeddingResult,
  CachedEmbeddingsOptions,
  EmbeddingCache,
  EmbeddingCacheStats,
} from "./types";
import { generateEmbedding, stripMarkdown } from "./embeddings";
import {
  MODEL_NAME,
  DEFAULT_MAX_TEXT_LENGTH,
  DEFAULT_SNIPPET_LENGTH,
} from "./constants";

// ============================================================================
// Hashing
// ============================================================================

/**
 * Generate a content hash for an entry using node:crypto.
 * Uses SHA-256 for reliable content change detection.
 */
function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Prepare text for hashing from an entry.
 */
function getEntryText(entry: SearchableEntry): string {
  const title = typeof entry["title"] === "string" ? entry["title"] : "";
  const content = typeof entry["content"] === "string" ? entry["content"] : "";
  return `${title}\n\n${content}`;
}

// ============================================================================
// Cache Operations
// ============================================================================

const CACHE_FILE = "embeddings.json";

/**
 * Get the cache file path.
 */
function getCachePath(cacheDir: string): string {
  return path.join(cacheDir, CACHE_FILE);
}

/**
 * Load embedding cache from disk.
 */
async function loadCache(cacheDir: string): Promise<EmbeddingCache | null> {
  const cachePath = getCachePath(cacheDir);
  try {
    const data = await readFile(cachePath, "utf-8");
    const cache = JSON.parse(data) as EmbeddingCache;

    // Validate version
    if (cache.version !== 1) {
      console.warn(
        `[embeddings] Cache file version mismatch (expected 1, got ${cache.version}), regenerating cache`
      );
      return null;
    }

    return cache;
  } catch (error) {
    // File doesn't exist - that's normal, no warning needed
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    // JSON parse error or other corruption - warn user
    if (error instanceof SyntaxError) {
      console.warn(
        `[embeddings] Cache file corrupted at ${cachePath}, regenerating cache`
      );
    } else if (error instanceof Error) {
      console.warn(
        `[embeddings] Failed to read cache file: ${error.message}, regenerating cache`
      );
    }

    return null;
  }
}

/**
 * Save embedding cache to disk.
 */
async function saveCache(
  cacheDir: string,
  cache: EmbeddingCache
): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    const cachePath = getCachePath(cacheDir);
    await writeFile(cachePath, JSON.stringify(cache), "utf-8");
  } catch (error) {
    throw new DocksError(
      `Failed to save embedding cache: ${error instanceof Error ? error.message : String(error)}`,
      "CACHE_WRITE_ERROR",
      { cacheDir }
    );
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Generate embeddings with caching.
 * Only regenerates embeddings for entries whose content has changed.
 *
 * @param entries - Content entries to embed
 * @param options - Generation and cache options
 * @returns Embedding results and cache stats
 */
export async function generateEmbeddingsWithCache(
  entries: SearchableEntry[],
  options: CachedEmbeddingsOptions = {}
): Promise<{ results: EmbeddingResult[]; stats: EmbeddingCacheStats }> {
  const {
    cacheDir = ".docks/cache",
    force = false,
    onProgress,
    maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
    snippetLength = DEFAULT_SNIPPET_LENGTH,
  } = options;

  // Filter valid entries with warnings for skipped
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

  const stats: EmbeddingCacheStats = {
    hits: 0,
    misses: 0,
    total: validEntries.length,
    hitRate: 0,
  };

  // Load existing cache
  const cache = force ? null : await loadCache(cacheDir);
  const newCache: EmbeddingCache = {
    version: 1,
    model: MODEL_NAME,
    entries: {},
  };

  const results: EmbeddingResult[] = [];

  for (let i = 0; i < validEntries.length; i++) {
    const entry = validEntries[i]!;
    const entryId = entry["id"] as string;
    const text = getEntryText(entry);
    const hash = hashContent(text);

    onProgress?.({
      current: i + 1,
      total: validEntries.length,
      entry: String(entry["title"] ?? entry["slug"]),
    });

    // Check cache
    const cached = cache?.entries[entryId];
    if (cached && cached.hash === hash) {
      // Cache hit
      stats.hits++;
      results.push({
        id: cached.id,
        slug: cached.slug,
        collection: cached.collection,
        title: cached.title,
        snippet: cached.snippet,
        embedding: cached.embedding,
      });

      // Copy to new cache
      newCache.entries[entryId] = cached;
      continue;
    }

    // Cache miss - generate embedding
    stats.misses++;

    // Prepare text for embedding
    const content =
      typeof entry["content"] === "string" ? entry["content"] : "";
    const cleanContent = stripMarkdown(content);
    const title = typeof entry["title"] === "string" ? entry["title"] : "";
    const embeddingText = (
      title ? `${title}\n\n${cleanContent}` : cleanContent
    ).slice(0, maxTextLength);

    const embedding = await generateEmbedding(embeddingText);

    // Create snippet using same logic as embeddings.ts
    let snippet: string;
    if (cleanContent.length <= snippetLength) {
      snippet = cleanContent;
    } else {
      const cut = cleanContent.slice(0, snippetLength);
      const lastSpace = cut.lastIndexOf(" ");
      snippet =
        lastSpace > snippetLength * 0.8
          ? cut.slice(0, lastSpace) + "..."
          : cut + "...";
    }

    const result: EmbeddingResult = {
      id: entryId,
      slug: entry["slug"] as string,
      collection: entry["collection"] as string,
      title: title || (entry["slug"] as string),
      snippet,
      embedding,
    };

    results.push(result);

    // Add to new cache
    newCache.entries[entryId] = {
      hash,
      ...result,
      cachedAt: new Date().toISOString(),
    };
  }

  // Save updated cache
  await saveCache(cacheDir, newCache);

  stats.hitRate = stats.total > 0 ? stats.hits / stats.total : 0;

  return { results, stats };
}

/**
 * Clear the embedding cache.
 */
export async function clearEmbeddingCache(
  cacheDir = ".docks/cache"
): Promise<void> {
  try {
    await rm(getCachePath(cacheDir));
  } catch {
    // Cache file doesn't exist, that's fine
  }
}

/**
 * Get cache statistics without loading full cache.
 */
export async function getEmbeddingCacheStats(cacheDir = ".docks/cache"): Promise<{
  exists: boolean;
  entryCount: number;
  model: string | null;
}> {
  const cache = await loadCache(cacheDir);
  if (!cache) {
    return { exists: false, entryCount: 0, model: null };
  }

  return {
    exists: true,
    entryCount: Object.keys(cache.entries).length,
    model: cache.model,
  };
}
