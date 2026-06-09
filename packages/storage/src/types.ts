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
}
