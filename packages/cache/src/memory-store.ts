import type { CacheStore, StoredEntry } from "./types";

/**
 * The default store: a plain Map in process memory.
 *
 * Fast, zero-dependency, and entirely ephemeral — it lives and dies with the
 * process. Reach for `sqlStore` when the cache must survive a restart or be
 * shared across workers.
 */
export class MemoryStore implements CacheStore {
  private readonly entries = new Map<string, StoredEntry>();

  get(key: string): StoredEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: StoredEntry): void {
    this.entries.set(key, entry);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
