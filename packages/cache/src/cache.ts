import { systemClock } from "./time";

import type { CacheStore, Clock } from "./types";

export interface CacheOptions {
  readonly store: CacheStore;

  /** Defaults to the system clock; tests inject a frozen one for determinism. */
  readonly clock?: Clock;
}

/** Optional knobs for a single write. */
export interface WriteOptions {
  /** Time-to-live in ms. Omitted → the entry never expires. */
  readonly ttlMs?: number;
}

/**
 * A TTL cache over a pluggable store.
 *
 * Expiry policy lives here, in one place: the store remembers entries verbatim,
 * and the cache decides whether a remembered entry is still alive by comparing
 * its deadline against the injected clock. An expired entry is treated as a miss
 * and evicted on read, so stale rows never accumulate behind a hot key.
 */
export class Cache {
  private readonly store: CacheStore;

  private readonly clock: Clock;

  constructor(options: CacheOptions) {
    this.store = options.store;

    // The default clock branch: real time unless a test pins it.
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Return the live cached value, or produce, cache, and return a fresh one.
   *
   * On a hit `produce` is never called — that is the whole point of a cache. On
   * a miss or an expired entry we produce a new value, write it, and return it.
   */
  async fetch<T>(key: string, produce: () => T | Promise<T>, options?: WriteOptions): Promise<T> {
    const live = this.read<T>(key);

    if (live !== undefined) return live;

    const produced = await produce();

    this.write(key, produced, options);

    return produced;
  }

  /**
   * Read a live value, or `undefined`.
   *
   * A missing key is a miss. An expired key is also a miss — and we delete it
   * here so the store sheds the dead entry the moment we notice it is dead.
   */
  read<T>(key: string): T | undefined {
    const entry = this.store.get(key);

    if (entry === undefined) return undefined;

    // `null` means never expires; otherwise the deadline is in epoch ms.
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock()) {
      this.store.delete(key);

      return undefined;
    }

    return entry.value as T;
  }

  /** Write a value, optionally with a TTL. No TTL → the entry never expires. */
  write(key: string, value: unknown, options?: WriteOptions): void {
    const ttlMs = options?.ttlMs;

    const expiresAt = ttlMs === undefined ? null : this.clock() + ttlMs;

    this.store.set(key, { value, expiresAt });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}
