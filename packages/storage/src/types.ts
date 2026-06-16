/**
 * The storage substrate is an interface, not a driver.
 *
 * `Storage` depends on this contract alone, so the bytes can live in process
 * memory, on the local disk, or in S3 without a caller ever knowing which.
 */
export interface StorageBackend {
  /** Write `data` at `key`, overwriting any prior value. */
  put(key: string, data: Buffer): Promise<void>;

  /** Read the bytes at `key`; throws STORAGE_NOT_FOUND when absent. */
  get(key: string): Promise<Buffer>;

  /** Remove `key`; a no-op when the key is already absent. */
  delete(key: string): Promise<void>;

  /** Whether `key` currently holds a value. */
  exists(key: string): Promise<boolean>;

  /** Every key, optionally narrowed to those starting with `prefix`. */
  list(prefix?: string): Promise<string[]>;

  /**
   * A URL that resolves to the object at `key`, when the backend can mint one.
   *
   * Optional: only object-store backends (S3/R2) implement this. The facade's
   * `Storage.url()` throws `STORAGE_URL_UNSUPPORTED` for backends that omit it
   * (memory, file) — there is no URL for bytes that live only in a process or
   * behind the local disk.
   */
  url?(key: string, options?: UrlOptions): Promise<string>;
}

/** How `url()` should expose the object. */
export interface UrlOptions {
  /**
   * Mint a time-limited presigned URL valid for this many seconds. Omit (or
   * pass `0`) for a plain public URL, which only resolves if the bucket/object
   * is publicly readable.
   */
  readonly expiresInSeconds?: number;
}
