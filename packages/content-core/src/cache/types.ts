import type { DocumentMeta } from "../types";

export interface CacheManifest {
  version: number;
  coreVersion: string;
  lastUpdated: number;
  configHash: string;
  collections: Record<string, CollectionCacheMeta>;
}

export interface CollectionCacheMeta {
  schemaHash: string;
  transformHash: string | null;
  parserHash: string;
  entryCount: number;
}

export interface CachedParseResult {
  contentHash: string;
  data: Record<string, unknown>;
  content: string;
  slug: string;
  meta: DocumentMeta;
}

export interface CachedTransformResult {
  parseHash: string;
  transformed: Record<string, unknown> | null;
  skipped: boolean;
  /** Rendered markdown output for auto-flattened entries (no transform) */
  rendered?: {
    html: string | null;
    headings: Array<{ depth: number; slug: string; text: string }>;
    readingTime: { minutes: number; words: number };
    excerpt: string;
  };
  /** Bundled MDX code for MDX entries */
  mdxCode?: string;
}

export interface CacheOptions {
  enabled?: boolean;
  cacheDir?: string;
  clearCache?: boolean;
  /** Maximum entries per cache Map to prevent unbounded memory growth (default: 10000) */
  maxEntries?: number;
}

export interface CacheStats {
  parseHits: number;
  parseMisses: number;
  transformHits: number;
  transformMisses: number;
  timeSaved: number;
}

// Bump this when cache format changes to invalidate old caches
export const CACHE_VERSION = 4;
