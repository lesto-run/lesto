import xxhash from "xxhash-wasm";

let hasherInstance: Awaited<ReturnType<typeof xxhash>> | null = null;

export async function initHasher(): Promise<void> {
  if (!hasherInstance) {
    hasherInstance = await xxhash();
  }
}

async function getHasher(): Promise<Awaited<ReturnType<typeof xxhash>>> {
  if (!hasherInstance) {
    await initHasher();
  }
  return hasherInstance!;
}

export async function hashString(input: string): Promise<string> {
  const hasher = await getHasher();
  return hasher.h64ToString(input);
}

export async function hashBuffer(input: Uint8Array): Promise<string> {
  const hasher = await getHasher();
  return hasher.h64Raw(input).toString(16).padStart(16, "0");
}

/**
 * Deterministically serialize a value with recursively sorted object keys.
 *
 * WHY not `JSON.stringify(obj, Object.keys(obj).toSorted())`: passing an array
 * as the second argument makes it a property ALLOWLIST applied at EVERY nesting
 * level, not a key sorter. With only the top-level keys allowed, every nested
 * object collapses to `{}` — so two collections with different nested schemas
 * hash identically and the parse cache never invalidates on a nested change.
 * We instead walk the structure ourselves, sorting keys at each level so the
 * hash reflects the full nested shape while staying stable across key order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);

  return `{${entries.join(",")}}`;
}

export async function hashObject(obj: unknown): Promise<string> {
  return hashString(stableStringify(obj));
}

export async function hashFunction(fn: Function): Promise<string> {
  return hashString(fn.toString());
}

export async function combineHashes(...hashes: string[]): Promise<string> {
  return hashString(hashes.join(":"));
}

export function createSyncHasher(): {
  hash: (input: string) => string;
  hashObject: (obj: unknown) => string;
} {
  if (!hasherInstance) {
    throw new Error("Hasher not initialized. Call initHasher() first.");
  }

  const h = hasherInstance;

  return {
    hash: (input: string) => h.h64ToString(input),
    // Same deterministic, fully-nested serialization as hashObject — see the
    // note on stableStringify for why the JSON.stringify replacer-array form is
    // unsafe (it drops nested keys, so the cache never busts on nested changes).
    hashObject: (obj: unknown) => h.h64ToString(stableStringify(obj)),
  };
}
