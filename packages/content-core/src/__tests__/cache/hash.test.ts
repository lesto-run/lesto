import { describe, it, expect, beforeAll } from "vitest";
import {
  initHasher,
  hashString,
  hashBuffer,
  hashObject,
  hashFunction,
  combineHashes,
  createSyncHasher,
} from "../../cache/hash";

// Fixture functions hashed by the tests below; declared at module scope as they capture nothing.
function namedTestFn() {
  return 42;
}
const constStringFn = () => "test";
const stringFn1 = () => "test1";
const stringFn2 = () => "test2";

describe("hash utilities", () => {
  beforeAll(async () => {
    await initHasher();
  });

  describe("initHasher", () => {
    it("initializes without error", async () => {
      await expect(initHasher()).resolves.toBeUndefined();
    });

    it("can be called multiple times safely", async () => {
      await initHasher();
      await initHasher();
      await expect(initHasher()).resolves.toBeUndefined();
    });
  });

  describe("hashString", () => {
    it("returns consistent hash for same input", async () => {
      const input = "test string";
      const hash1 = await hashString(input);
      const hash2 = await hashString(input);

      expect(hash1).toBe(hash2);
      expect(hash1).toBeTruthy();
      expect(typeof hash1).toBe("string");
    });

    it("returns different hash for different input", async () => {
      const hash1 = await hashString("test string 1");
      const hash2 = await hashString("test string 2");

      expect(hash1).not.toBe(hash2);
    });

    it("handles empty strings", async () => {
      const hash = await hashString("");
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe("string");
    });

    it("handles unicode characters", async () => {
      const hash1 = await hashString("Hello 世界");
      const hash2 = await hashString("Hello 世界");

      expect(hash1).toBe(hash2);
    });
  });

  describe("hashBuffer", () => {
    it("returns consistent hash for same buffer", async () => {
      const buffer = new Uint8Array([1, 2, 3, 4, 5]);
      const hash1 = await hashBuffer(buffer);
      const hash2 = await hashBuffer(buffer);

      expect(hash1).toBe(hash2);
      expect(hash1).toBeTruthy();
      expect(typeof hash1).toBe("string");
    });

    it("returns different hash for different buffers", async () => {
      const buffer1 = new Uint8Array([1, 2, 3]);
      const buffer2 = new Uint8Array([4, 5, 6]);
      const hash1 = await hashBuffer(buffer1);
      const hash2 = await hashBuffer(buffer2);

      expect(hash1).not.toBe(hash2);
    });

    it("handles empty buffers", async () => {
      const buffer = new Uint8Array([]);
      const hash = await hashBuffer(buffer);
      expect(hash).toBeTruthy();
    });
  });

  describe("hashObject", () => {
    it("returns consistent hash for same object", async () => {
      const obj = { title: "Test", count: 42, nested: { value: true } };
      const hash1 = await hashObject(obj);
      const hash2 = await hashObject(obj);

      expect(hash1).toBe(hash2);
    });

    it("returns same hash for objects with keys in different order", async () => {
      const obj1 = { a: 1, b: 2, c: 3 };
      const obj2 = { c: 3, b: 2, a: 1 };
      const hash1 = await hashObject(obj1);
      const hash2 = await hashObject(obj2);

      expect(hash1).toBe(hash2);
    });

    it("returns different hash for different objects", async () => {
      const obj1 = { title: "Test 1" };
      const obj2 = { title: "Test 2" };
      const hash1 = await hashObject(obj1);
      const hash2 = await hashObject(obj2);

      expect(hash1).not.toBe(hash2);
    });

    it("handles nested objects", async () => {
      const obj = {
        level1: {
          level2: {
            level3: "deep value",
          },
        },
      };
      const hash1 = await hashObject(obj);
      const hash2 = await hashObject(obj);

      expect(hash1).toBe(hash2);
    });

    it("handles arrays", async () => {
      const obj = { items: [1, 2, 3], tags: ["a", "b", "c"] };
      const hash = await hashObject(obj);

      expect(hash).toBeTruthy();
    });
  });

  describe("hashFunction", () => {
    it("hashes function source code", async () => {
      const hash = await hashFunction(namedTestFn);

      expect(hash).toBeTruthy();
      expect(typeof hash).toBe("string");
    });

    it("returns consistent hash for same function", async () => {
      const hash1 = await hashFunction(constStringFn);
      const hash2 = await hashFunction(constStringFn);

      expect(hash1).toBe(hash2);
    });

    it("returns different hash for different functions", async () => {
      const hash1 = await hashFunction(stringFn1);
      const hash2 = await hashFunction(stringFn2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("combineHashes", () => {
    it("combines multiple hashes into one", async () => {
      const hash1 = await hashString("test1");
      const hash2 = await hashString("test2");
      const combined = await combineHashes(hash1, hash2);

      expect(combined).toBeTruthy();
      expect(typeof combined).toBe("string");
      expect(combined).not.toBe(hash1);
      expect(combined).not.toBe(hash2);
    });

    it("returns consistent result for same inputs", async () => {
      const hash1 = await hashString("test1");
      const hash2 = await hashString("test2");
      const combined1 = await combineHashes(hash1, hash2);
      const combined2 = await combineHashes(hash1, hash2);

      expect(combined1).toBe(combined2);
    });

    it("returns different result for different order", async () => {
      const hash1 = await hashString("test1");
      const hash2 = await hashString("test2");
      const combined1 = await combineHashes(hash1, hash2);
      const combined2 = await combineHashes(hash2, hash1);

      expect(combined1).not.toBe(combined2);
    });

    it("handles single hash", async () => {
      const hash = await hashString("test");
      const combined = await combineHashes(hash);

      expect(combined).toBeTruthy();
    });

    it("handles many hashes", async () => {
      const hashes = await Promise.all([
        hashString("a"),
        hashString("b"),
        hashString("c"),
        hashString("d"),
        hashString("e"),
      ]);
      const combined = await combineHashes(...hashes);

      expect(combined).toBeTruthy();
    });
  });

  describe("createSyncHasher", () => {
    it("creates sync hasher after init", async () => {
      await initHasher();
      const hasher = createSyncHasher();

      expect(hasher).toBeDefined();
      expect(hasher.hash).toBeInstanceOf(Function);
      expect(hasher.hashObject).toBeInstanceOf(Function);
    });

    it("hash returns consistent results", async () => {
      await initHasher();
      const hasher = createSyncHasher();
      const hash1 = hasher.hash("test");
      const hash2 = hasher.hash("test");

      expect(hash1).toBe(hash2);
    });

    it("hash returns different results for different inputs", async () => {
      await initHasher();
      const hasher = createSyncHasher();
      const hash1 = hasher.hash("test1");
      const hash2 = hasher.hash("test2");

      expect(hash1).not.toBe(hash2);
    });

    it("hashObject returns consistent results", async () => {
      await initHasher();
      const hasher = createSyncHasher();
      const obj = { title: "Test", count: 42 };
      const hash1 = hasher.hashObject(obj);
      const hash2 = hasher.hashObject(obj);

      expect(hash1).toBe(hash2);
    });

    it("hashObject handles key ordering", async () => {
      await initHasher();
      const hasher = createSyncHasher();
      const obj1 = { a: 1, b: 2 };
      const obj2 = { b: 2, a: 1 };
      const hash1 = hasher.hashObject(obj1);
      const hash2 = hasher.hashObject(obj2);

      expect(hash1).toBe(hash2);
    });
  });
});
