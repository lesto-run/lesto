import { describe, it, expect, vi, beforeEach } from "vitest";
import { query } from "../query";
import type { RuntimeEntry } from "../types";
import * as runtime from "../runtime";

describe("Query.paginate()", () => {
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
      title: "Post 1",
      draft: false,
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
      title: "Post 2",
      draft: false,
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
      title: "Post 3",
      draft: true,
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
      title: "Post 4",
      draft: false,
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
      title: "Post 5",
      draft: false,
      publishedAt: new Date("2024-01-05"),
      content: "Content 5",
    },
    {
      id: "posts/post-6",
      collection: "posts",
      file: {
        path: "post-6.md",
        fileName: "post-6",
        extension: "md",
        directory: ".",
        pathSegments: [],
        isIndex: false,
      },
      slug: "post-6",
      title: "Post 6",
      draft: false,
      publishedAt: new Date("2024-01-06"),
      content: "Content 6",
    },
  ];

  beforeEach(() => {
    // Mock getCollection to return our test data
    vi.spyOn(runtime, "getCollection").mockReturnValue([...mockEntries]);
  });

  it("should paginate basic results", async () => {
    const result = await query("posts").paginate({ page: 1, perPage: 3 });

    expect(result.entries).toHaveLength(3);
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.perPage).toBe(3);
    expect(result.pagination.total).toBe(6);
    expect(result.pagination.totalPages).toBe(2);
    expect(result.pagination.hasNext).toBe(true);
    expect(result.pagination.hasPrev).toBe(false);
  });

  it("should paginate second page", async () => {
    const result = await query("posts").paginate({ page: 2, perPage: 3 });

    expect(result.entries).toHaveLength(3);
    expect(result.pagination.page).toBe(2);
    expect(result.pagination.perPage).toBe(3);
    expect(result.pagination.total).toBe(6);
    expect(result.pagination.totalPages).toBe(2);
    expect(result.pagination.hasNext).toBe(false);
    expect(result.pagination.hasPrev).toBe(true);
  });

  it("should work with where clause", async () => {
    const result = await query("posts")
      .where("draft", "!=", true)
      .paginate({ page: 1, perPage: 2 });

    expect(result.entries).toHaveLength(2);
    expect(result.pagination.total).toBe(5); // 5 non-draft posts
    expect(result.pagination.totalPages).toBe(3);
    expect(result.pagination.hasNext).toBe(true);
    expect(result.pagination.hasPrev).toBe(false);

    // Check that all entries are not drafts
    result.entries.forEach((entry) => {
      expect(entry.draft).not.toBe(true);
    });
  });

  it("should work with orderBy", async () => {
    const result = await query("posts")
      .orderBy("publishedAt", "desc")
      .paginate({ page: 1, perPage: 3 });

    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]?.title).toBe("Post 6");
    expect(result.entries[1]?.title).toBe("Post 5");
    expect(result.entries[2]?.title).toBe("Post 4");
  });

  it("should handle page beyond total pages", async () => {
    const result = await query("posts").paginate({ page: 10, perPage: 3 });

    expect(result.entries).toHaveLength(0);
    expect(result.pagination.page).toBe(10);
    expect(result.pagination.total).toBe(6);
    expect(result.pagination.totalPages).toBe(2);
    expect(result.pagination.hasNext).toBe(false);
    expect(result.pagination.hasPrev).toBe(true);
  });

  it("should handle uneven last page", async () => {
    const result = await query("posts").paginate({ page: 2, perPage: 4 });

    expect(result.entries).toHaveLength(2); // Only 2 items on last page
    expect(result.pagination.page).toBe(2);
    expect(result.pagination.perPage).toBe(4);
    expect(result.pagination.total).toBe(6);
    expect(result.pagination.totalPages).toBe(2);
    expect(result.pagination.hasNext).toBe(false);
    expect(result.pagination.hasPrev).toBe(true);
  });

  it("should handle single page of results", async () => {
    const result = await query("posts").paginate({ page: 1, perPage: 10 });

    expect(result.entries).toHaveLength(6);
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.total).toBe(6);
    expect(result.pagination.totalPages).toBe(1);
    expect(result.pagination.hasNext).toBe(false);
    expect(result.pagination.hasPrev).toBe(false);
  });

  it("should work with combined where and orderBy", async () => {
    const result = await query("posts")
      .where("draft", "!=", true)
      .orderBy("publishedAt", "desc")
      .paginate({ page: 2, perPage: 2 });

    expect(result.entries).toHaveLength(2);
    expect(result.pagination.total).toBe(5); // 5 non-draft posts
    expect(result.pagination.page).toBe(2);
    expect(result.entries[0]?.title).toBe("Post 4");
    expect(result.entries[1]?.title).toBe("Post 2");
  });

  describe("invalid pagination input", () => {
    // Regression: page < 1 yields a negative offset (wrong slice) and perPage < 1
    // makes totalPages Infinity/NaN. These must be rejected with a coded error.
    it("throws for page <= 0", () => {
      expect(() => query("posts").paginate({ page: 0, perPage: 3 })).toThrow();
      expect(() => query("posts").paginate({ page: -1, perPage: 3 })).toThrow();
    });

    it("throws for perPage <= 0", () => {
      expect(() => query("posts").paginate({ page: 1, perPage: 0 })).toThrow();
      expect(() => query("posts").paginate({ page: 1, perPage: -5 })).toThrow();
    });

    it("throws a ValidationError carrying a stable code", () => {
      try {
        query("posts").paginate({ page: 0, perPage: 3 });
        expect.unreachable("paginate must throw for page < 1");
      } catch (error) {
        expect((error as { code?: string }).code).toBeDefined();
      }
    });
  });
});
