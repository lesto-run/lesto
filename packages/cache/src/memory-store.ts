import type { CacheStore, StoredEntry } from "./types";

/**
 * The default store: a plain Map in process memory.
 *
 * Fast, zero-dependency, and entirely ephemeral — it lives and dies with the
 * process. Reach for `sqlStore` when the cache must survive a restart or be
 * shared across workers.
 *
 * The verbs are `async` to satisfy the Promise-returning `CacheStore` contract
 * (ADR 0006). The work itself is a synchronous Map operation; resolving an
 * already-settled value is the whole cost of the async shape here.
 */
export class MemoryStore implements CacheStore {
  private readonly entries = new Map<string, StoredEntry>();

  async get(key: string): Promise<StoredEntry | undefined> {
    return this.entries.get(key);
  }

  async set(key: string, entry: StoredEntry): Promise<void> {
    this.entries.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}
