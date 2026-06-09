import { describe, it, expect } from "vitest";
import { query } from "../index";

interface TestItem {
  slug: string;
  title: string;
  order: number;
}

/** Index into an array, asserting the element is present (test fixtures are known-length). */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Expected element at index ${index} but found none`);
  }
  return value;
}

const items: TestItem[] = [
  { slug: "first", title: "First", order: 1 },
  { slug: "second", title: "Second", order: 2 },
  { slug: "third", title: "Third", order: 3 },
  { slug: "fourth", title: "Fourth", order: 4 },
  { slug: "fifth", title: "Fifth", order: 5 },
];

describe("Query.pagination()", () => {
  describe("with direct item reference", () => {
    it("returns pagination context for middle item", () => {
      const ctx = query(items).orderBy("order").pagination(at(items, 2));

      expect(ctx).toBeDefined();
      expect(ctx?.prev?.title).toBe("Second");
      expect(ctx?.next?.title).toBe("Fourth");
      expect(ctx?.index).toBe(2);
      expect(ctx?.total).toBe(5);
      expect(ctx?.hasPrev).toBe(true);
      expect(ctx?.hasNext).toBe(true);
    });

    it("returns undefined prev for first item", () => {
      const ctx = query(items).orderBy("order").pagination(at(items, 0));

      expect(ctx).toBeDefined();
      expect(ctx?.prev).toBeUndefined();
      expect(ctx?.next?.title).toBe("Second");
      expect(ctx?.index).toBe(0);
      expect(ctx?.hasPrev).toBe(false);
      expect(ctx?.hasNext).toBe(true);
    });

    it("returns undefined next for last item", () => {
      const ctx = query(items).orderBy("order").pagination(at(items, 4));

      expect(ctx).toBeDefined();
      expect(ctx?.prev?.title).toBe("Fourth");
      expect(ctx?.next).toBeUndefined();
      expect(ctx?.index).toBe(4);
      expect(ctx?.hasPrev).toBe(true);
      expect(ctx?.hasNext).toBe(false);
    });

    it("returns undefined for item not in collection", () => {
      const notInList = { slug: "missing", title: "Missing", order: 99 };
      const ctx = query(items).pagination(notInList);

      expect(ctx).toBeUndefined();
    });
  });

  describe("with predicate function", () => {
    it("finds item by slug", () => {
      const ctx = query(items)
        .orderBy("order")
        .pagination((item) => item.slug === "third");

      expect(ctx).toBeDefined();
      expect(ctx?.prev?.title).toBe("Second");
      expect(ctx?.next?.title).toBe("Fourth");
      expect(ctx?.index).toBe(2);
    });

    it("works with first item by predicate", () => {
      const ctx = query(items)
        .orderBy("order")
        .pagination((item) => item.slug === "first");

      expect(ctx).toBeDefined();
      expect(ctx?.prev).toBeUndefined();
      expect(ctx?.next?.title).toBe("Second");
      expect(ctx?.hasPrev).toBe(false);
    });

    it("returns undefined when predicate matches nothing", () => {
      const ctx = query(items).pagination((item) => item.slug === "nonexistent");

      expect(ctx).toBeUndefined();
    });
  });

  describe("with filters and ordering", () => {
    it("respects where filters", () => {
      const filteredItems = [
        { slug: "a", title: "A", order: 1, published: true },
        { slug: "b", title: "B", order: 2, published: false },
        { slug: "c", title: "C", order: 3, published: true },
        { slug: "d", title: "D", order: 4, published: true },
      ];

      const ctx = query(filteredItems)
        .where({ published: true })
        .orderBy("order")
        .pagination((item) => item.slug === "c");

      expect(ctx).toBeDefined();
      // "b" is filtered out, so prev is "a"
      expect(ctx?.prev?.title).toBe("A");
      expect(ctx?.next?.title).toBe("D");
      expect(ctx?.total).toBe(3); // Only 3 published items
    });

    it("respects orderBy for prev/next", () => {
      const ctx = query(items)
        .orderBy("order", "desc")
        .pagination((item) => item.slug === "third");

      expect(ctx).toBeDefined();
      // In desc order: fifth, fourth, third, second, first
      // So prev of "third" is "fourth" and next is "second"
      expect(ctx?.prev?.title).toBe("Fourth");
      expect(ctx?.next?.title).toBe("Second");
    });
  });

  describe("edge cases", () => {
    it("handles single item collection", () => {
      const single = [{ slug: "only", title: "Only", order: 1 }];
      const ctx = query(single).pagination(at(single, 0));

      expect(ctx).toBeDefined();
      expect(ctx?.prev).toBeUndefined();
      expect(ctx?.next).toBeUndefined();
      expect(ctx?.index).toBe(0);
      expect(ctx?.total).toBe(1);
      expect(ctx?.hasPrev).toBe(false);
      expect(ctx?.hasNext).toBe(false);
    });

    it("handles empty collection", () => {
      const empty: TestItem[] = [];
      const ctx = query(empty).pagination((item) => item.slug === "any");

      expect(ctx).toBeUndefined();
    });

    it("handles two item collection - first item", () => {
      const two = items.slice(0, 2);
      const ctx = query(two).pagination(at(two, 0));

      expect(ctx).toBeDefined();
      expect(ctx?.prev).toBeUndefined();
      expect(ctx?.next?.title).toBe("Second");
      expect(ctx?.hasPrev).toBe(false);
      expect(ctx?.hasNext).toBe(true);
    });

    it("handles two item collection - second item", () => {
      const two = items.slice(0, 2);
      const ctx = query(two).pagination(at(two, 1));

      expect(ctx).toBeDefined();
      expect(ctx?.prev?.title).toBe("First");
      expect(ctx?.next).toBeUndefined();
      expect(ctx?.hasPrev).toBe(true);
      expect(ctx?.hasNext).toBe(false);
    });
  });
});
