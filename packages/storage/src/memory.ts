import { StorageError } from "./errors";

import type { StorageBackend } from "./types";

/**
 * An in-memory backend — a `Map` of key to bytes.
 *
 * **Local/dev only.** Perfect for tests and ephemeral caches; nothing survives
 * the process and nothing is shared across instances. Use `S3Backend` in
 * production. There is no `url()` — bytes in a `Map` have no addressable URL.
 */
export class MemoryBackend implements StorageBackend {
  private readonly store = new Map<string, Buffer>();

  async put(key: string, data: Buffer): Promise<void> {
    this.store.set(key, data);
  }

  async get(key: string): Promise<Buffer> {
    const data = this.store.get(key);

    if (data === undefined) {
      throw new StorageError("STORAGE_NOT_FOUND", `No object at key "${key}".`, { key });
    }

    return data;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async list(prefix?: string): Promise<string[]> {
    const keys = [...this.store.keys()];

    if (prefix === undefined) return keys;

    return keys.filter((key) => key.startsWith(prefix));
  }
}
