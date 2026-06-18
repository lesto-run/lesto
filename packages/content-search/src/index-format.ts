/**
 * JSON Search Index Format (Runtime)
 *
 * Functions for parsing and loading pre-built search indexes.
 * BUILD-TIME functions (serialization) are in @volo/content-embeddings.
 */

import { decodeFloat32Array } from "@volo/content-shared/encoding";
import type { SearchIndex } from "./types";

// ============================================================================
// Types
// ============================================================================

interface CompactEntry {
  i: string;
  s: string;
  c: string;
  t: string;
  n: string;
  e: string;
}

interface CompactSearchIndex {
  v: 1;
  m: string;
  d: number;
  b: string;
  e: CompactEntry[];
}

// ============================================================================
// Decoding
// ============================================================================

/**
 * Decode a base64 string to float32 array.
 * Uses shared encoding utility for cross-environment compatibility.
 */
function decodeEmbedding(encoded: string): number[] {
  return Array.from(decodeFloat32Array(encoded));
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Type guard for compact search index format.
 */
function isCompactSearchIndex(data: unknown): data is CompactSearchIndex {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    obj["v"] === 1 &&
    typeof obj["m"] === "string" &&
    typeof obj["d"] === "number" &&
    typeof obj["b"] === "string" &&
    Array.isArray(obj["e"])
  );
}

/**
 * Type guard for regular search index format.
 */
function isSearchIndex(data: unknown): data is SearchIndex {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    Array.isArray(obj["entries"]) &&
    typeof obj["dimensions"] === "number" &&
    typeof obj["model"] === "string" &&
    typeof obj["builtAt"] === "string"
  );
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse JSON string to SearchIndex.
 * Handles both compact and regular formats.
 *
 * @param json - JSON string from serializeSearchIndex()
 * @returns SearchIndex for use with search functions
 */
export function parseSearchIndex(json: string): SearchIndex {
  const parsed: unknown = JSON.parse(json);

  // Check if compact format
  if (isCompactSearchIndex(parsed)) {
    return {
      entries: parsed.e.map((entry) => ({
        id: entry.i,
        slug: entry.s,
        collection: entry.c,
        title: entry.t,
        snippet: entry.n,
        embedding: decodeEmbedding(entry.e),
      })),
      dimensions: parsed.d,
      model: parsed.m,
      builtAt: parsed.b,
    };
  }

  // Regular format
  if (isSearchIndex(parsed)) {
    return parsed;
  }

  throw new Error("Invalid search index format");
}

/**
 * Load a search index from a URL.
 * For use in browsers to load pre-built index.
 *
 * @param url - URL to the search index JSON file
 * @returns SearchIndex
 */
export async function loadSearchIndex(url: string): Promise<SearchIndex> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load search index: ${response.status}`);
  }
  const json = await response.text();
  return parseSearchIndex(json);
}
