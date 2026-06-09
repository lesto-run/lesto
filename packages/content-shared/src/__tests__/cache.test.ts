import { describe, it, expect, vi } from "vitest";
import {
  CACHE_LIMITS,
  CACHE_TTL,
  createCache,
  createImmutableCache,
  deepClone,
  createWeakCache,
} from "../cache.js";

describe("CACHE_LIMITS", () => {
  it("has expected limit values", () => {
    expect(CACHE_LIMITS.TRANSFORM_CONTEXT).toBe(500);
    expect(CACHE_LIMITS.YAML_PARSE).toBe(1000);
    expect(CACHE_LIMITS.SEARCH_INDEX).toBe(10);
    expect(CACHE_LIMITS.EMBEDDINGS).toBe(100);
    expect(CACHE_LIMITS.LINT_PARAGRAPH).toBe(200);
    expect(CACHE_LIMITS.LINT_DB).toBe(1000);
  });
});

describe("CACHE_TTL", () => {
  it("has expected TTL values in milliseconds", () => {
    expect(CACHE_TTL.SHORT).toBe(5 * 60 * 1000);
    expect(CACHE_TTL.MEDIUM).toBe(60 * 60 * 1000);
    expect(CACHE_TTL.LONG).toBe(24 * 60 * 60 * 1000);
    expect(CACHE_TTL.PERSISTENT).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("createCache", () => {
  it("creates a cache with max limit", () => {
    const cache = createCache<string>({ max: 3 });

    cache.set("a", "value-a");
    cache.set("b", "value-b");
    cache.set("c", "value-c");

    expect(cache.size).toBe(3);

    // Adding one more should evict the least recently used
    cache.set("d", "value-d");
    expect(cache.size).toBe(3);
    expect(cache.has("a")).toBe(false);
    expect(cache.get("d")).toBe("value-d");
  });

  it("supports get and set operations", () => {
    const cache = createCache<number>({ max: 10 });

    cache.set("key1", 42);
    expect(cache.get("key1")).toBe(42);
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("supports has and delete operations", () => {
    const cache = createCache<string>({ max: 10 });

    cache.set("key", "value");
    expect(cache.has("key")).toBe(true);
    expect(cache.has("other")).toBe(false);

    cache.delete("key");
    expect(cache.has("key")).toBe(false);
  });

  it("supports clear operation", () => {
    const cache = createCache<string>({ max: 10 });

    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");

    expect(cache.size).toBe(3);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("updates age on get when configured", () => {
    const cache = createCache<string>({ max: 3 });

    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");

    // Access 'a' to update its age
    cache.get("a");

    // Add new entry - should evict 'b' (least recently used)
    cache.set("d", "4");

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.has("d")).toBe(true);
  });

  it("calls onEviction callback when entries are evicted", () => {
    const onEviction = vi.fn();
    const cache = createCache<string>({ max: 2, onEviction });

    cache.set("a", "value-a");
    cache.set("b", "value-b");
    cache.set("c", "value-c"); // This should evict 'a'

    expect(onEviction).toHaveBeenCalledWith("value-a", "a", expect.any(String));
  });

  it("supports TTL expiration", async () => {
    const cache = createCache<string>({ max: 10, ttl: 50 });

    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(cache.get("key")).toBeUndefined();
  });

  it("supports size calculation", () => {
    const cache = createCache<string>({
      max: 100,
      maxSize: 20,
      sizeCalculation: (value) => value.length,
    });

    cache.set("a", "12345"); // size 5
    cache.set("b", "1234567890"); // size 10

    expect(cache.size).toBe(2);

    // Adding this should cause eviction due to size limit
    cache.set("c", "123456789012345"); // size 15, total would be 30 > 20

    expect(cache.size).toBeLessThan(3);
  });

  it("handles objects as values", () => {
    interface TestObj {
      id: number;
      name: string;
    }
    const cache = createCache<TestObj>({ max: 10 });

    const obj = { id: 1, name: "test" };
    cache.set("obj", obj);

    const retrieved = cache.get("obj");
    expect(retrieved).toEqual(obj);
    expect(retrieved).toBe(obj); // Same reference
  });
});

const simpleClone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("createImmutableCache", () => {
  it("clones values on get", () => {
    const cache = createImmutableCache<{ data: string }>(
      { max: 10 },
      simpleClone
    );

    const original = { data: "original" };
    cache.set("key", original);

    const retrieved = cache.get("key");
    expect(retrieved).toEqual(original);
    expect(retrieved).not.toBe(original); // Different reference

    // Mutating retrieved should not affect cache
    if (retrieved) {
      retrieved.data = "mutated";
    }
    const retrieved2 = cache.get("key");
    expect(retrieved2?.data).toBe("original");
  });

  it("clones values on set", () => {
    const cache = createImmutableCache<{ data: string }>(
      { max: 10 },
      simpleClone
    );

    const original = { data: "original" };
    cache.set("key", original);

    // Mutating original should not affect cache
    original.data = "mutated";

    const retrieved = cache.get("key");
    expect(retrieved?.data).toBe("original");
  });

  it("returns undefined for missing keys", () => {
    const cache = createImmutableCache<string>({ max: 10 }, simpleClone);
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("supports has operation", () => {
    const cache = createImmutableCache<string>({ max: 10 }, simpleClone);

    cache.set("key", "value");
    expect(cache.has("key")).toBe(true);
    expect(cache.has("other")).toBe(false);
  });

  it("supports delete operation", () => {
    const cache = createImmutableCache<string>({ max: 10 }, simpleClone);

    cache.set("key", "value");
    expect(cache.has("key")).toBe(true);

    const deleted = cache.delete("key");
    expect(deleted).toBe(true);
    expect(cache.has("key")).toBe(false);

    const deletedAgain = cache.delete("key");
    expect(deletedAgain).toBe(false);
  });

  it("supports clear operation", () => {
    const cache = createImmutableCache<string>({ max: 10 }, simpleClone);

    cache.set("a", "1");
    cache.set("b", "2");

    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("reports correct size", () => {
    const cache = createImmutableCache<string>({ max: 10 }, simpleClone);

    expect(cache.size).toBe(0);
    cache.set("a", "1");
    expect(cache.size).toBe(1);
    cache.set("b", "2");
    expect(cache.size).toBe(2);
    cache.delete("a");
    expect(cache.size).toBe(1);
  });
});

describe("deepClone", () => {
  it("returns primitives as-is", () => {
    expect(deepClone(42)).toBe(42);
    expect(deepClone("string")).toBe("string");
    expect(deepClone(true)).toBe(true);
    expect(deepClone(null)).toBe(null);
    expect(deepClone(undefined)).toBe(undefined);
  });

  it("clones plain objects", () => {
    const original = { a: 1, b: "two", c: true };
    const cloned = deepClone(original);

    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
  });

  it("clones nested objects", () => {
    const original = {
      level1: {
        level2: {
          value: "deep",
        },
      },
    };
    const cloned = deepClone(original);

    expect(cloned).toEqual(original);
    expect(cloned.level1).not.toBe(original.level1);
    expect(cloned.level1.level2).not.toBe(original.level1.level2);
  });

  it("clones arrays", () => {
    const original = [1, 2, 3];
    const cloned = deepClone(original);

    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
  });

  it("clones nested arrays", () => {
    const original = [[1, 2], [3, 4], [[5, 6]]];
    const cloned = deepClone(original);

    expect(cloned).toEqual(original);
    expect(cloned[0]).not.toBe(original[0]);
    const clonedThird = cloned[2];
    const originalThird = original[2];
    expect(clonedThird).toBeDefined();
    expect(originalThird).toBeDefined();
    expect(clonedThird?.[0]).not.toBe(originalThird?.[0]);
  });

  it("clones arrays of objects", () => {
    const original = [{ id: 1 }, { id: 2 }];
    const cloned = deepClone(original);

    expect(cloned).toEqual(original);
    expect(cloned[0]).not.toBe(original[0]);
  });

  it("clones Date objects", () => {
    const original = new Date("2024-01-01T00:00:00.000Z");
    const cloned = deepClone(original);

    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.getTime()).toBe(original.getTime());
  });

  it("clones Map objects", () => {
    const original = new Map([
      ["key1", { value: 1 }],
      ["key2", { value: 2 }],
    ]);
    const cloned = deepClone(original);

    expect(cloned).not.toBe(original);
    expect(cloned.size).toBe(original.size);
    expect(cloned.get("key1")).toEqual(original.get("key1"));
    expect(cloned.get("key1")).not.toBe(original.get("key1"));
  });

  it("clones Set objects", () => {
    const obj1 = { id: 1 };
    const obj2 = { id: 2 };
    const original = new Set([obj1, obj2]);
    const cloned = deepClone(original);

    expect(cloned).not.toBe(original);
    expect(cloned.size).toBe(original.size);

    const clonedArray = Array.from(cloned);
    expect(clonedArray[0]).toEqual(obj1);
    expect(clonedArray[0]).not.toBe(obj1);
  });

  it("handles complex nested structures", () => {
    const original = {
      array: [1, { nested: "value" }],
      date: new Date("2024-01-01"),
      map: new Map([["key", [1, 2, 3]]]),
      set: new Set([{ a: 1 }]),
      plain: { b: 2 },
    };
    const cloned = deepClone(original);

    expect(cloned).toEqual(original);
    expect(cloned.array).not.toBe(original.array);
    expect(cloned.array[1]).not.toBe(original.array[1]);
    expect(cloned.date).not.toBe(original.date);
    expect(cloned.map).not.toBe(original.map);
    expect(cloned.set).not.toBe(original.set);
    expect(cloned.plain).not.toBe(original.plain);
  });

  it("handles empty structures", () => {
    expect(deepClone({})).toEqual({});
    expect(deepClone([])).toEqual([]);
    expect(deepClone(new Map())).toEqual(new Map());
    expect(deepClone(new Set())).toEqual(new Set());
  });

  it("preserves object key order", () => {
    const original = { c: 3, a: 1, b: 2 };
    const cloned = deepClone(original);

    expect(Object.keys(cloned)).toEqual(Object.keys(original));
  });
});

describe("createWeakCache", () => {
  it("stores and retrieves objects", () => {
    const cache = createWeakCache<{ data: string }>();

    const obj = { data: "test" };
    cache.set("key", obj);

    const retrieved = cache.get("key");
    expect(retrieved).toBe(obj);
  });

  it("returns undefined for missing keys", () => {
    const cache = createWeakCache<{ data: string }>();
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("supports delete operation", () => {
    const cache = createWeakCache<{ data: string }>();

    const obj = { data: "test" };
    cache.set("key", obj);

    expect(cache.get("key")).toBe(obj);

    const deleted = cache.delete("key");
    expect(deleted).toBe(true);
    expect(cache.get("key")).toBeUndefined();
  });

  it("overwrites existing entries", () => {
    const cache = createWeakCache<{ data: string }>();

    const obj1 = { data: "first" };
    const obj2 = { data: "second" };

    cache.set("key", obj1);
    expect(cache.get("key")).toBe(obj1);

    cache.set("key", obj2);
    expect(cache.get("key")).toBe(obj2);
  });

  it("holds weak references", () => {
    const cache = createWeakCache<{ data: string }>();

    // Create and store object
    let obj: { data: string } | null = { data: "test" };
    cache.set("key", obj);

    expect(cache.get("key")).toBe(obj);

    // Note: We can't reliably test GC behavior, but we can verify
    // the WeakRef structure is used correctly
    obj = null;

    // The cache still has the key in its internal Map
    // but the WeakRef may have been garbage collected
    // We can't deterministically test this as GC is non-deterministic
  });

  it("handles multiple entries", () => {
    const cache = createWeakCache<{ id: number }>();

    const obj1 = { id: 1 };
    const obj2 = { id: 2 };
    const obj3 = { id: 3 };

    cache.set("a", obj1);
    cache.set("b", obj2);
    cache.set("c", obj3);

    expect(cache.get("a")).toBe(obj1);
    expect(cache.get("b")).toBe(obj2);
    expect(cache.get("c")).toBe(obj3);

    cache.delete("b");

    expect(cache.get("a")).toBe(obj1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(obj3);
  });
});

describe("cache integration scenarios", () => {
  it("works with YAML-like parsed data", () => {
    const cache = createImmutableCache<Record<string, unknown>>(
      { max: CACHE_LIMITS.YAML_PARSE },
      deepClone
    );

    const frontmatter = {
      title: "Test Document",
      date: "2024-01-01",
      tags: ["a", "b", "c"],
      nested: { author: "Test" },
    };

    cache.set("doc1", frontmatter);

    const retrieved = cache.get("doc1");
    expect(retrieved).toEqual(frontmatter);
    expect(retrieved).not.toBe(frontmatter);
    expect(retrieved?.tags).not.toBe(frontmatter.tags);
    expect(retrieved?.nested).not.toBe(frontmatter.nested);

    // Mutation test
    if (retrieved) {
      (retrieved.tags as string[]).push("d");
      (retrieved.nested as Record<string, string>).author = "Modified";
    }

    const retrieved2 = cache.get("doc1");
    expect(retrieved2).toBeDefined();
    expect((retrieved2!.tags as string[]).length).toBe(3);
    expect((retrieved2!.nested as Record<string, string>).author).toBe("Test");
  });

  it("works with transform context data", () => {
    const cache = createCache<{
      content: string;
      metadata: Record<string, string>;
    }>({
      max: CACHE_LIMITS.TRANSFORM_CONTEXT,
      ttl: CACHE_TTL.MEDIUM,
    });

    for (let i = 0; i < 10; i++) {
      cache.set(`doc-${i}`, {
        content: `Content for doc ${i}`,
        metadata: { id: String(i) },
      });
    }

    expect(cache.size).toBe(10);
    expect(cache.get("doc-5")?.content).toBe("Content for doc 5");
  });
});
