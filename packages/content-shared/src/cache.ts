import { LRUCache } from "lru-cache";

/**
 * Standard cache limits for the monorepo.
 * Document why each limit was chosen.
 */
export const CACHE_LIMITS = {
  /** Context cache - fits typical doc site (~500 pages) */
  TRANSFORM_CONTEXT: 500,
  /** YAML parsing - typical frontmatter blocks */
  YAML_PARSE: 1000,
  /** Search indexes (memory-heavy) */
  SEARCH_INDEX: 10,
  /** Embedding vectors - each ~1.5KB */
  EMBEDDINGS: 100,
  /** Lint diagnostics per paragraph */
  LINT_PARAGRAPH: 200,
  /** DB entries for lint cache */
  LINT_DB: 1000,
} as const;

/**
 * Standard TTL values in milliseconds.
 */
export const CACHE_TTL = {
  /** Short-lived cache (5 minutes) */
  SHORT: 5 * 60 * 1000,
  /** Medium cache (1 hour) */
  MEDIUM: 60 * 60 * 1000,
  /** Long cache (1 day) */
  LONG: 24 * 60 * 60 * 1000,
  /** Persistent cache (1 week) */
  PERSISTENT: 7 * 24 * 60 * 60 * 1000,
} as const;

export interface CacheOptions<V> {
  /** Maximum number of entries */
  max: number;
  /** Time-to-live in milliseconds */
  ttl?: number;
  /** Calculate size of a value (for memory-based limits) */
  sizeCalculation?: (value: V) => number;
  /** Maximum total size (requires sizeCalculation) */
  maxSize?: number;
  /** Called when an entry is evicted */
  onEviction?: (
    value: V,
    key: string,
    reason: "evict" | "set" | "delete" | "expire" | "fetch",
  ) => void;
}

/**
 * Create a typed LRU cache with standard configuration.
 */
export function createCache<V extends {}>(options: CacheOptions<V>): LRUCache<string, V> {
  const cacheOptions: LRUCache.Options<string, V, unknown> = {
    max: options.max,
    allowStale: false,
    updateAgeOnGet: true,
  };

  if (options.ttl !== undefined) {
    cacheOptions.ttl = options.ttl;
  }
  if (options.sizeCalculation !== undefined) {
    cacheOptions.sizeCalculation = options.sizeCalculation;
  }
  if (options.maxSize !== undefined) {
    cacheOptions.maxSize = options.maxSize;
  }
  if (options.onEviction !== undefined) {
    cacheOptions.dispose = options.onEviction;
  }

  return new LRUCache<string, V>(cacheOptions);
}

/**
 * Create a cache that clones values to prevent mutation.
 * Use when cached objects might be modified by callers.
 */
export function createImmutableCache<V extends {}>(
  options: CacheOptions<V>,
  clone: (value: V) => V,
): {
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
  has: (key: string) => boolean;
  delete: (key: string) => boolean;
  clear: () => void;
  size: number;
} {
  const cache = createCache<V>(options);

  return {
    get(key: string): V | undefined {
      const value = cache.get(key);
      return value !== undefined ? clone(value) : undefined;
    },
    set(key: string, value: V): void {
      cache.set(key, clone(value));
    },
    has(key: string): boolean {
      return cache.has(key);
    },
    delete(key: string): boolean {
      return cache.delete(key);
    },
    clear(): void {
      cache.clear();
    },
    get size(): number {
      return cache.size;
    },
  };
}

/**
 * Deep clone a value for cache isolation.
 */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(deepClone) as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  if (value instanceof Map) {
    return new Map(Array.from(value.entries()).map(([k, v]) => [k, deepClone(v)])) as unknown as T;
  }
  if (value instanceof Set) {
    return new Set(Array.from(value).map(deepClone)) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    result[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return result as T;
}

/**
 * Create a WeakRef-based cache for automatic GC of unused entries.
 */
export function createWeakCache<V extends object>(): {
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
  delete: (key: string) => boolean;
} {
  const cache = new Map<string, WeakRef<V>>();
  const registry = new FinalizationRegistry<string>((key) => {
    const ref = cache.get(key);
    if (ref && ref.deref() === undefined) {
      cache.delete(key);
    }
  });

  return {
    get(key: string): V | undefined {
      const ref = cache.get(key);
      return ref?.deref();
    },
    set(key: string, value: V): void {
      cache.set(key, new WeakRef(value));
      registry.register(value, key);
    },
    delete(key: string): boolean {
      return cache.delete(key);
    },
  };
}
