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

export async function hashObject(obj: unknown): Promise<string> {
  // Handle null, undefined, and primitives
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return hashString(JSON.stringify(obj));
  }

  // Handle arrays - hash them in order
  if (Array.isArray(obj)) {
    return hashString(JSON.stringify(obj));
  }

  // For objects, sort keys for consistent hashing
  const json = JSON.stringify(obj, Object.keys(obj).toSorted());
  return hashString(json);
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
    hashObject: (obj: unknown) => {
      // Handle null, undefined, and primitives
      if (obj === null || obj === undefined || typeof obj !== "object") {
        return h.h64ToString(JSON.stringify(obj));
      }
      // Handle arrays - hash them in order
      if (Array.isArray(obj)) {
        return h.h64ToString(JSON.stringify(obj));
      }
      // For objects, sort keys for consistent hashing
      const json = JSON.stringify(obj, Object.keys(obj).toSorted());
      return h.h64ToString(json);
    },
  };
}
