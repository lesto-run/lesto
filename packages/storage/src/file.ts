import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { Dirent } from "node:fs";

import { StorageError } from "./errors";

import type { StorageBackend } from "./types";

/**
 * A backend that maps keys to files under a single root directory.
 *
 * Keys are relative POSIX-ish paths; parent directories are created on `put`.
 * A path-traversal guard refuses any key that could escape the root.
 */
export class FileBackend implements StorageBackend {
  constructor(private readonly rootDir: string) {}

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.resolve(key);

    // Create the directory tree the key implies before writing into it.
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Buffer> {
    const path = this.resolve(key);

    try {
      return await readFile(path);
    } catch {
      // A missing file is the only failure we model; surface it as NOT_FOUND.
      throw new StorageError("STORAGE_NOT_FOUND", `No object at key "${key}".`, { key });
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.resolve(key);

    // `force` makes deleting an already-absent key a no-op, as the contract asks.
    await rm(path, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    const path = this.resolve(key);

    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix?: string): Promise<string[]> {
    const keys = await this.walk(this.rootDir);

    if (prefix === undefined) return keys;

    return keys.filter((key) => key.startsWith(prefix));
  }

  /** Recursively gather the keys (paths relative to the root) under `dir`. */
  private async walk(dir: string): Promise<string[]> {
    let entries: Dirent[];

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // The root may not exist yet (nothing has been put); that is an empty list.
      return [];
    }

    const keys: string[] = [];

    for (const entry of entries) {
      const child = join(dir, entry.name);

      if (entry.isDirectory()) {
        keys.push(...(await this.walk(child)));
        continue;
      }

      // Keys are root-relative and always forward-slashed, regardless of OS.
      keys.push(relative(this.rootDir, child).split(sep).join("/"));
    }

    return keys;
  }

  /** Validate the key and join it onto the root, refusing any escape. */
  private resolve(key: string): string {
    // The two ways a key could climb out of the root: a parent ref or an absolute path.
    if (key.includes("..") || key.startsWith("/")) {
      throw new StorageError("STORAGE_INVALID_KEY", `Unsafe storage key "${key}".`, { key });
    }

    return join(this.rootDir, key);
  }
}
