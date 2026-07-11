import { systemClock } from "./time";

import type { CacheStore, Clock, StoredEntry } from "./types";

/**
 * The default cap on a {@link MemoryStore}'s entry count.
 *
 * Matches the same order-of-magnitude default other unbounded-by-default
 * surfaces in this monorepo settled on (`DEFAULT_MAX_BUFFERED_SPANS` in
 * `@lesto/observability`, `DEFAULT_MAX_CONNECTIONS` in `@lesto/runtime`):
 * generous enough that no ordinary app-scale cache ever notices it, small
 * enough that a runaway key space (unbounded user input as a key, a bug that
 * never re-reads a written key) cannot grow this store without limit.
 */
const DEFAULT_MAX_ENTRIES = 10_000;

export interface MemoryStoreOptions {
  /**
   * The most entries this store holds at once. A HARD bound, not a hint: once
   * exceeded, the least-recently-used entry is evicted to make room for the
   * write that crossed the cap. Defaults to {@link DEFAULT_MAX_ENTRIES}.
   */
  readonly maxEntries?: number;

  /** Defaults to the system clock; tests inject a frozen one for determinism. */
  readonly clock?: Clock;
}

/**
 * The default store: a plain Map in process memory, bounded and self-cleaning.
 *
 * Fast, zero-dependency, and entirely ephemeral — it lives and dies with the
 * process. Reach for `sqlStore` when the cache must survive a restart or be
 * shared across workers.
 *
 * The verbs are `async` to satisfy the Promise-returning `CacheStore` contract
 * (ADR 0006). The work itself is a synchronous Map operation; resolving an
 * already-settled value is the whole cost of the async shape here.
 *
 * **Bounded, LRU-evicting.** A `Map` iterates in insertion order, and both
 * `get` and `set` re-insert the touched key — so the front of the map is
 * always the least-recently-used entry, and eviction is just "pop from the
 * front." That gives O(1)-ish LRU bookkeeping with no separate linked list or
 * index to maintain.
 *
 * **Sweeps expired entries first.** The {@link import("./cache").Cache} policy
 * only evicts an expired entry when it is next READ — a key written with a
 * TTL and never read again would otherwise sit here forever, unbounded by
 * time even though it is bounded in count. So once the cap is exceeded,
 * eviction discards every already-expired entry before reaching for a merely
 * old (but still live) one — a dead entry never displaces a live one.
 */
export class MemoryStore implements CacheStore {
  private readonly entries = new Map<string, StoredEntry>();

  private readonly maxEntries: number;

  private readonly clock: Clock;

  constructor(options: MemoryStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.clock = options.clock ?? systemClock;
  }

  async get(key: string): Promise<StoredEntry | undefined> {
    const entry = this.entries.get(key);

    if (entry === undefined) return undefined;

    // Touch: delete-then-set moves this key to the MRU end (a Map iterates in
    // insertion order), so the LRU victim is always whatever is left at the
    // front — this is the whole eviction-order bookkeeping.
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry;
  }

  async set(key: string, entry: StoredEntry): Promise<void> {
    // Delete first so re-writing an existing key also moves it to the MRU
    // end, exactly like a `get` touch — a write is itself a use.
    this.entries.delete(key);
    this.entries.set(key, entry);

    this.evictOverflow();
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  /**
   * Bring the store back within `maxEntries`, expired entries first.
   *
   * Only runs once the cap is actually exceeded, so a store that never grows
   * past its cap (the common case) pays nothing beyond the `set` that was
   * already happening.
   */
  private evictOverflow(): void {
    if (this.entries.size <= this.maxEntries) return;

    const now = this.clock();

    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.entries.delete(key);
    }

    // Still over the cap after the sweep: pop the least-recently-used entries
    // off the front, oldest first, until back within bounds. A single pass
    // over the (already order-preserving) key iterator, stopping as soon as
    // enough have gone — no re-querying `.keys()` per victim.
    let overflow = this.entries.size - this.maxEntries;

    for (const key of this.entries.keys()) {
      if (overflow <= 0) break;

      this.entries.delete(key);
      overflow -= 1;
    }
  }
}
