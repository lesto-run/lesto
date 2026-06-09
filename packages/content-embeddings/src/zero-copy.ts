/**
 * Zero-Copy Binary Index Format (Build-time)
 *
 * A memory-mapped binary format requiring zero parsing and zero copying.
 * The index is usable the instant bytes arrive.
 *
 * This module contains BUILD-TIME functions for creating zero-copy indexes.
 * RUNTIME functions (ZeroCopyIndex class) are in @keel/content-search.
 */

import type { ZeroCopyInputEntry } from "./types";
import { binaryQuantize } from "./binary";
import { EMBEDDING_DIMENSIONS, BINARY_SIGNATURE_SIZE } from "./constants";

// ============================================================================
// Constants
// ============================================================================

/** Magic bytes: "QSEARCH\0" */
const MAGIC = new Uint8Array([0x51, 0x53, 0x45, 0x41, 0x52, 0x43, 0x48, 0x00]);

/** Format version */
const VERSION = 1;

/** Header size in bytes */
const HEADER_SIZE = 64;

/** Entry size in bytes (fixed for O(1) access) */
const ENTRY_SIZE = 72;

/** Binary signature size for 384-dim embeddings (same as BINARY_SIGNATURE_SIZE) */
const SIGNATURE_SIZE = BINARY_SIGNATURE_SIZE;

/** Sentinel value for empty strings (max Uint32) */
const EMPTY_STRING_SENTINEL = 0xffffffff;

/** Feature flags */
export enum IndexFlags {
  /** Has binary signatures */
  HAS_SIGNATURES = 1 << 0,
  /** Has bloom filters */
  HAS_BLOOM = 1 << 1,
  /** Has cluster data */
  HAS_CLUSTERS = 1 << 2,
  /** Strings are UTF-8 */
  UTF8_STRINGS = 1 << 3,
}

// ============================================================================
// Index Builder
// ============================================================================

/**
 * Create a zero-copy binary index from entries.
 *
 * @param entries - Entries with binary signatures
 * @returns ArrayBuffer containing the binary index
 */
export function createZeroCopyIndex(entries: ZeroCopyInputEntry[]): ArrayBuffer {
  if (entries.length === 0) {
    throw new Error("Cannot create index from empty entries");
  }

  // Build string table
  const encoder = new TextEncoder();
  const strings: Uint8Array[] = [];
  const stringOffsets = new Map<string, number>();
  let currentStringOffset = 0;

  const addString = (s: string): number => {
    if (s === "") return EMPTY_STRING_SENTINEL;
    if (stringOffsets.has(s)) {
      return stringOffsets.get(s)!;
    }
    const offset = currentStringOffset;
    const encoded = encoder.encode(s + "\0"); // null-terminated
    strings.push(encoded);
    stringOffsets.set(s, offset);
    currentStringOffset += encoded.length;
    return offset;
  };

  // Pre-add all strings
  const entryStringOffsets = entries.map((entry) => ({
    id: addString(entry.id),
    title: addString(entry.title),
    slug: addString(entry.slug),
    snippet: addString(entry.snippet),
    collection: addString(entry.collection),
  }));

  // Calculate sizes
  const entriesSize = entries.length * ENTRY_SIZE;
  const stringsSize = currentStringOffset;
  const totalSize = HEADER_SIZE + entriesSize + stringsSize;

  // Allocate buffer
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const uint8View = new Uint8Array(buffer);

  // Write header
  uint8View.set(MAGIC, 0);
  view.setUint32(8, VERSION, true);
  view.setUint32(12, IndexFlags.HAS_SIGNATURES | IndexFlags.UTF8_STRINGS, true);
  view.setUint32(16, entries.length, true);
  view.setUint32(20, EMBEDDING_DIMENSIONS, true); // dimensions
  view.setUint32(24, SIGNATURE_SIZE, true);
  view.setBigUint64(32, BigInt(HEADER_SIZE), true); // entries offset
  view.setBigUint64(40, BigInt(HEADER_SIZE + entriesSize), true); // strings offset
  view.setBigUint64(48, BigInt(0), true); // bloom offset (none)

  // Write entries
  let entryOffset = HEADER_SIZE;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const offsets = entryStringOffsets[i]!;

    view.setUint32(entryOffset + 0, offsets.id, true);
    view.setUint32(entryOffset + 4, offsets.title, true);
    view.setUint32(entryOffset + 8, offsets.slug, true);
    view.setUint32(entryOffset + 12, offsets.snippet, true);
    view.setUint32(entryOffset + 16, offsets.collection, true);
    // Bytes 20-23 reserved - zero-initialize to avoid uninitialized memory
    view.setUint32(entryOffset + 20, 0, true);
    uint8View.set(entry.binarySignature.slice(0, SIGNATURE_SIZE), entryOffset + 24);

    entryOffset += ENTRY_SIZE;
  }

  // Write string table
  let stringOffset = HEADER_SIZE + entriesSize;
  for (const encoded of strings) {
    uint8View.set(encoded, stringOffset);
    stringOffset += encoded.length;
  }

  return buffer;
}

/**
 * Convert EmbeddingResult with binary signature to ZeroCopyInputEntry.
 */
export function toZeroCopyInput(entry: {
  id: string;
  title: string;
  slug: string;
  snippet: string;
  collection: string;
  binaryEmbedding: Uint8Array;
}): ZeroCopyInputEntry {
  return {
    id: entry.id,
    title: entry.title,
    slug: entry.slug,
    snippet: entry.snippet,
    collection: entry.collection,
    binarySignature: entry.binaryEmbedding,
  };
}

/**
 * Create ZeroCopyInputEntry from an EmbeddingResult by quantizing the embedding.
 */
export function toZeroCopyInputFromEmbedding(entry: {
  id: string;
  title: string;
  slug: string;
  snippet: string;
  collection: string;
  embedding: number[];
}): ZeroCopyInputEntry {
  return {
    id: entry.id,
    title: entry.title,
    slug: entry.slug,
    snippet: entry.snippet,
    collection: entry.collection,
    binarySignature: binaryQuantize(entry.embedding),
  };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Estimate the size of a zero-copy index.
 */
export function estimateZeroCopySize(
  entries: Array<{
    id: string;
    title: string;
    slug: string;
    snippet: string;
    collection: string;
  }>,
): number {
  const encoder = new TextEncoder();
  const uniqueStrings = new Set<string>();

  for (const entry of entries) {
    uniqueStrings.add(entry.id);
    uniqueStrings.add(entry.title);
    uniqueStrings.add(entry.slug);
    uniqueStrings.add(entry.snippet);
    uniqueStrings.add(entry.collection);
  }

  let stringsSize = 0;
  for (const s of uniqueStrings) {
    stringsSize += encoder.encode(s).length + 1; // +1 for null terminator
  }

  return HEADER_SIZE + entries.length * ENTRY_SIZE + stringsSize;
}

/**
 * Validate a zero-copy index buffer.
 */
export function validateZeroCopyIndex(buffer: ArrayBuffer): {
  valid: boolean;
  error?: string;
  entryCount?: number;
} {
  try {
    const view = new DataView(buffer);

    // Check magic
    const magic = new Uint8Array(buffer, 0, 8);
    for (let i = 0; i < 8; i++) {
      if (magic[i] !== MAGIC[i]) {
        return { valid: false, error: "Invalid magic bytes" };
      }
    }

    // Check version
    const version = view.getUint32(8, true);
    if (version !== VERSION) {
      return { valid: false, error: `Unsupported version: ${version}` };
    }

    const entryCount = view.getUint32(16, true);
    return { valid: true, entryCount };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
