import { describe, it, expect, vi, beforeEach } from "vitest";
import { nn } from "./test-utils";
import { query, Query } from "../query";
import type { RuntimeEntry } from "../types";
import * as runtime from "../runtime";

describe("Query", () => {
  // Mock data for testing - uses flattened entry structure
  const mockEntries: RuntimeEntry[] = [
    {
      id: "posts/post-1",
      collection: "posts",
      file: {
        path: "post-1.md",
        fileName: "post-1",
        extension: "md",
        directory: ".",
        pathSegments: [],
        isIndex: false,
      },
      slug: "post-1",
      title: "First Post",
      draft: false,
      count: 5,
      category: "tech",
      tags: ["javascript", "typescript"],
      publishedAt: new Date("2024-01-01"),
      content: "Content 1",
    },
    {
      id: "posts/post-2",
      collection: "posts",
      file: {
        path: "post-2.md",
        fileName: "post-2",
        extension: "md",
        directory: ".",
        pathSegments: [],
        isIndex: false,
      },
      slug: "post-2",
      title: "Second Post",
      draft: true,
      count: 10,
      category: "news",
      tags: ["javascript", "react"],
      publishedAt: new Date("2024-01-02"),
      content: "Content 2",
    },
    {
      id: "posts/post-3",
      collection: "posts",
      file: {
        path: "post-3.md",
        fileName: "post-3",
        extension: "md",
        directory: ".",
        pathSegments: [],
        isIndex: false,
      },
      slug: "post-3",
      title: "Third Post",
      draft: false,
      count: 15,
      category: "tech",
      tags: ["typescript", "node"],
      publishedAt: new Date("2024-01-03"),
      content: "Content 3",
    },
    {
      id: "posts/post-4",
      collection: "posts",
      file: {
        path: "post-4.md",
        fileName: "post-4",
        extension: "md",
        directory: ".",
        pathSegments: [],
        isIndex: false,
      },
      slug: "post-4",
      title: "Fourth Post",
      draft: false,
      count: 8,
      category: "news",
      tags: ["javascript"],
      publishedAt: new Date("2024-01-04"),
      content: "Content 4",
    },
    {
      id: "posts/post-5",
      collection: "posts",
      file: {
        path: "post-5.md",
        fileName: "post-5",
        extension: "md",
        directory: ".",
        pathSegments: [],
        isIndex: false,
      },
      slug: "post-5",
      title: "Fifth Post",
      draft: false,
      count: 3,
      category: "tech",
      tags: ["python"],
      publishedAt: new Date("2024-01-05"),
      content: "Content 5",
    },
  ];

  beforeEach(() => {
    // Mock getCollection to return our test data
    vi.spyOn(runtime, "getCollection").mockReturnValue([...mockEntries]);
  });

  describe("where clause with == operator", () => {
    it("filters entries where draft == false", async () => {
      const result = await query("posts").where("draft", "==", false).get();

      expect(result).toHaveLength(4);
      expect(result.every((e) => e.draft === false)).toBe(true);
    });

    it("filters entries where category == tech", async () => {
      const result = await query("posts").where("category", "==", "tech").get();

      expect(result).toHaveLength(3);
      expect(result.every((e) => e.category === "tech")).toBe(true);
    });
  });

  describe("where clause with != operator", () => {
    it("filters entries where draft != true", async () => {
      const result = await query("posts").where("draft", "!=", true).get();

      expect(result).toHaveLength(4);
      expect(result.every((e) => e.draft !== true)).toBe(true);
    });

    it("filters entries where category != news", async () => {
      const result = await query("posts").where("category", "!=", "news").get();

      expect(result).toHaveLength(3);
      expect(result.every((e) => e.category !== "news")).toBe(true);
    });
  });

  describe("where clause with < operator", () => {
    it("filters entries where count < 10", async () => {
      const result = await query("posts").where("count", "<", 10).get();

      expect(result).toHaveLength(3);
      expect(result.every((e) => (e.count as number) < 10)).toBe(true);
      expect(result.map((e) => e.count)).toEqual([5, 8, 3]);
    });
  });

  describe("where clause with <= operator", () => {
    it("filters entries where count <= 10", async () => {
      const result = await query("posts").where("count", "<=", 10).get();

      expect(result).toHaveLength(4);
      expect(result.every((e) => (e.count as number) <= 10)).toBe(true);
      expect(result.map((e) => e.count)).toEqual([5, 10, 8, 3]);
    });
  });

  describe("where clause with > operator", () => {
    it("filters entries where count > 5", async () => {
      const result = await query("posts").where("count", ">", 5).get();

      expect(result).toHaveLength(3);
      expect(result.every((e) => (e.count as number) > 5)).toBe(true);
      expect(result.map((e) => e.count)).toEqual([10, 15, 8]);
    });
  });

  describe("where clause with >= operator", () => {
    it("filters entries where count >= 5", async () => {
      const result = await query("posts").where("count", ">=", 5).get();

      expect(result).toHaveLength(4);
      expect(result.every((e) => (e.count as number) >= 5)).toBe(true);
      expect(result.map((e) => e.count)).toEqual([5, 10, 15, 8]);
    });
  });

  describe("where clause with in operator", () => {
    it("filters entries where category in [tech, news]", async () => {
      const result = await query("posts").where("category", "in", ["tech", "news"]).get();

      expect(result).toHaveLength(5);
      expect(result.every((e) => ["tech", "news"].includes(e.category as string))).toBe(true);
    });

    it("filters entries where category in [tech]", async () => {
      const result = await query("posts").where("category", "in", ["tech"]).get();

      expect(result).toHaveLength(3);
      expect(result.every((e) => e.category === "tech")).toBe(true);
    });
  });

  describe("where clause with contains operator", () => {
    it("filters entries where tags contains javascript", async () => {
      const result = await query("posts").where("tags", "contains", "javascript").get();

      expect(result).toHaveLength(3);
      expect(
        result.every((e) => {
          const tags = e.tags as string[];
          return Array.isArray(tags) && tags.includes("javascript");
        }),
      ).toBe(true);
    });

    it("filters entries where tags contains typescript", async () => {
      const result = await query("posts").where("tags", "contains", "typescript").get();

      expect(result).toHaveLength(2);
      expect(
        result.every((e) => {
          const tags = e.tags as string[];
          return Array.isArray(tags) && tags.includes("typescript");
        }),
      ).toBe(true);
    });
  });

  describe("orderBy", () => {
    it("sorts entries by publishedAt in ascending order", async () => {
      const result = await query("posts").orderBy("publishedAt", "asc").get();

      expect(result).toHaveLength(5);
      const dates = result.map((e) => (e.publishedAt as Date).getTime());
      expect(dates).toEqual([...dates].toSorted((a, b) => a - b));
    });

    it("sorts entries by publishedAt in descending order", async () => {
      const result = await query("posts").orderBy("publishedAt", "desc").get();

      expect(result).toHaveLength(5);
      const dates = result.map((e) => (e.publishedAt as Date).getTime());
      expect(dates).toEqual([...dates].toSorted((a, b) => b - a));
    });

    it("sorts entries by count in ascending order", async () => {
      const result = await query("posts").orderBy("count", "asc").get();

      expect(result).toHaveLength(5);
      expect(result.map((e) => e.count)).toEqual([3, 5, 8, 10, 15]);
    });

    it("sorts entries by title in ascending order", async () => {
      const result = await query("posts").orderBy("title", "asc").get();

      expect(result).toHaveLength(5);
      expect(result.map((e) => e.title)).toEqual([
        "Fifth Post",
        "First Post",
        "Fourth Post",
        "Second Post",
        "Third Post",
      ]);
    });

    it("defaults to ascending order when dir is not specified", async () => {
      const result = await query("posts").orderBy("count").get();

      expect(result).toHaveLength(5);
      expect(result.map((e) => e.count)).toEqual([3, 5, 8, 10, 15]);
    });
  });

  describe("limit", () => {
    it("limits results to 5 entries", async () => {
      const result = await query("posts").limit(5).get();

      expect(result).toHaveLength(5);
    });

    it("limits results to 3 entries", async () => {
      const result = await query("posts").limit(3).get();

      expect(result).toHaveLength(3);
      expect(result.map((e) => e.slug)).toEqual(["post-1", "post-2", "post-3"]);
    });

    it("limits results to 1 entry", async () => {
      const result = await query("posts").limit(1).get();

      expect(result).toHaveLength(1);
      expect(nn(result[0]).slug).toBe("post-1");
    });
  });

  describe("offset", () => {
    it("skips first 2 entries", async () => {
      const result = await query("posts").offset(2).get();

      expect(result).toHaveLength(3);
      expect(result.map((e) => e.slug)).toEqual(["post-3", "post-4", "post-5"]);
    });

    it("skips first 4 entries", async () => {
      const result = await query("posts").offset(4).get();

      expect(result).toHaveLength(1);
      expect(nn(result[0]).slug).toBe("post-5");
    });

    it("returns empty array when offset exceeds total entries", async () => {
      const result = await query("posts").offset(10).get();

      expect(result).toHaveLength(0);
    });
  });

  describe("chaining multiple where clauses", () => {
    it("filters with multiple conditions: draft == false AND category == tech", async () => {
      const result = await query("posts")
        .where("draft", "==", false)
        .where("category", "==", "tech")
        .get();

      expect(result).toHaveLength(3);
      expect(result.every((e) => e.draft === false && e.category === "tech")).toBe(true);
    });

    it("filters with multiple conditions: count > 5 AND count < 15", async () => {
      const result = await query("posts").where("count", ">", 5).where("count", "<", 15).get();

      expect(result).toHaveLength(2);
      expect(result.map((e) => e.count)).toEqual([10, 8]);
    });

    it("filters with multiple conditions: draft == false AND tags contains javascript", async () => {
      const result = await query("posts")
        .where("draft", "==", false)
        .where("tags", "contains", "javascript")
        .get();

      expect(result).toHaveLength(2);
      expect(
        result.every((e) => {
          const tags = e.tags as string[];
          return e.draft === false && Array.isArray(tags) && tags.includes("javascript");
        }),
      ).toBe(true);
    });
  });

  describe("combining all methods", () => {
    it("applies where, orderBy, limit, and offset together", async () => {
      const result = await query("posts")
        .where("draft", "==", false)
        .orderBy("publishedAt", "desc")
        .limit(2)
        .offset(1)
        .get();

      expect(result).toHaveLength(2);
      // Should skip the first result after sorting and filtering
      expect(nn(result[0]).slug).toBe("post-4");
      expect(nn(result[1]).slug).toBe("post-3");
    });

    it("combines multiple where clauses with orderBy and limit", async () => {
      const result = await query("posts")
        .where("category", "==", "tech")
        .where("count", ">", 3)
        .orderBy("count", "asc")
        .limit(2)
        .get();

      expect(result).toHaveLength(2);
      expect(result.map((e) => e.count)).toEqual([5, 15]);
    });

    it("uses all operators in complex query", async () => {
      const result = await query("posts")
        .where("draft", "!=", true)
        .where("count", ">=", 5)
        .where("category", "in", ["tech", "news"])
        .orderBy("count", "desc")
        .offset(1)
        .limit(2)
        .get();

      expect(result).toHaveLength(2);
      // After filtering: posts with count >= 5, not draft, in tech or news
      // Sorted by count desc: 15, 8, 5
      // After offset(1): 8, 5
      // After limit(2): 8, 5
      expect(result.map((e) => e.count)).toEqual([8, 5]);
    });
  });

  describe("query function", () => {
    it("creates a Query instance", () => {
      const q = query("posts");
      expect(q).toBeInstanceOf(Query);
    });

    it("accepts collection name", async () => {
      const result = await query("posts").get();
      expect(result).toHaveLength(5);
      expect(runtime.getCollection).toHaveBeenCalledWith("posts");
    });
  });

  describe("edge cases", () => {
    it("handles empty collection", async () => {
      vi.spyOn(runtime, "getCollection").mockReturnValue([]);

      const result = await query("empty").get();
      expect(result).toHaveLength(0);
    });

    it("handles query with no matches", async () => {
      const result = await query("posts").where("category", "==", "nonexistent").get();

      expect(result).toHaveLength(0);
    });

    it("handles limit larger than result set", async () => {
      const result = await query("posts").limit(100).get();

      expect(result).toHaveLength(5);
    });

    it("handles offset at exactly total entries", async () => {
      const result = await query("posts").offset(5).get();

      expect(result).toHaveLength(0);
    });

    it("preserves method chaining order", async () => {
      // Different order should produce same results
      const result1 = await query("posts")
        .where("draft", "==", false)
        .orderBy("count")
        .limit(2)
        .get();

      const result2 = await query("posts")
        .limit(2)
        .orderBy("count")
        .where("draft", "==", false)
        .get();

      expect(result1.map((e) => e.slug)).toEqual(result2.map((e) => e.slug));
    });
  });

  describe("nested path access", () => {
    it("accesses top-level properties", async () => {
      const result = await query("posts").where("draft", "==", false).get();

      expect(result).toHaveLength(4);
      expect(result.every((e) => e.draft === false)).toBe(true);
    });

    it("handles deep nested paths", async () => {
      // Mock with deeper nesting
      const deepMockEntries: RuntimeEntry[] = [
        {
          id: "posts/deep-1",
          collection: "posts",
          file: {
            path: "deep-1.md",
            fileName: "deep-1",
            extension: "md",
            directory: ".",
            pathSegments: [],
            isIndex: false,
          },
          slug: "deep-1",
          meta: {
            author: {
              name: "John",
            },
          },
          content: "",
        },
      ];

      vi.spyOn(runtime, "getCollection").mockReturnValue(deepMockEntries);

      const result = await query("posts").where("meta.author.name", "==", "John").get();

      expect(result).toHaveLength(1);
    });
  });
});
