import { StorageError } from "./errors";

import type { StorageBackend, UrlOptions } from "./types";

/**
 * The object-storage facade.
 *
 * `Storage` delegates the raw byte operations to its injected backend and adds
 * text conveniences on top — utf8 encode on the way in, decode on the way out.
 */
export class Storage {
  constructor(private readonly backend: StorageBackend) {}

  async put(key: string, data: Buffer): Promise<void> {
    return this.backend.put(key, data);
  }

  async get(key: string): Promise<Buffer> {
    return this.backend.get(key);
  }

  async delete(key: string): Promise<void> {
    return this.backend.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.backend.exists(key);
  }

  async list(prefix?: string): Promise<string[]> {
    return this.backend.list(prefix);
  }

  /** Store `text` as utf8 bytes. */
  async putText(key: string, text: string): Promise<void> {
    return this.backend.put(key, Buffer.from(text, "utf8"));
  }

  /** Read the bytes at `key` and decode them as utf8. */
  async getText(key: string): Promise<string> {
    const data = await this.backend.get(key);

    return data.toString("utf8");
  }

  /**
   * A URL that resolves to the object at `key`.
   *
   * With `{ expiresInSeconds }` the URL is presigned and time-limited; without
   * it the URL is public (resolving only if the object is publicly readable).
   * Throws `STORAGE_URL_UNSUPPORTED` for backends that cannot mint URLs — the
   * memory and file backends serve bytes that have no addressable URL.
   */
  async url(key: string, options?: UrlOptions): Promise<string> {
    if (this.backend.url === undefined) {
      throw new StorageError(
        "STORAGE_URL_UNSUPPORTED",
        "This storage backend cannot produce URLs; use an S3/R2 backend.",
      );
    }

    return this.backend.url(key, options);
  }
}
