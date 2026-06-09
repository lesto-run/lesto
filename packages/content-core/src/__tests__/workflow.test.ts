import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nn } from "./test-utils";
import { query } from "../query";
import type { RuntimeEntry, WorkflowConfig } from "../types";
import * as runtime from "../runtime";

// Helper to create mock entries with workflow fields
const createMockEntry = (
  id: string,
  status: string,
  publishedAt?: Date,
  expiresAt?: Date,
): RuntimeEntry => ({
  id: `posts/${id}`,
  collection: "posts",
  file: {
    path: `${id}.md`,
    fileName: id,
    extension: "md",
    directory: ".",
    pathSegments: [],
    isIndex: false,
  },
  slug: id,
  title: `Post ${id}`,
  status,
  publishedAt,
  expiresAt,
  content: `Content for ${id}`,
});

describe("Workflow", () => {
  // Use dates that are clearly in the past or future relative to any reasonable "now"
  const pastDate = new Date("2020-01-01T12:00:00Z"); // Clearly in the past
  const futureDate = new Date("2050-01-01T12:00:00Z"); // Clearly in the future
  const expiredDate = new Date("2019-01-01T12:00:00Z"); // Expired (in the past)
  const notExpiredDate = new Date("2050-12-31T12:00:00Z"); // Not expired (in the future)

  const mockEntries: RuntimeEntry[] = [
    createMockEntry("published-1", "published", pastDate),
    createMockEntry("published-2", "published", pastDate, notExpiredDate), // Not expired
    createMockEntry("draft-1", "draft"),
    createMockEntry("draft-2", "draft", pastDate),
    createMockEntry("scheduled-1", "scheduled", futureDate),
    createMockEntry("scheduled-2", "published", futureDate), // Published status but future date
    createMockEntry("expired-1", "published", pastDate, expiredDate), // Expired
    createMockEntry("review-1", "review", pastDate),
  ];

  const workflowConfig: WorkflowConfig = {
    statusField: "status",
    publishDateField: "publishedAt",
    expirationField: "expiresAt",
  };

  beforeEach(() => {
    vi.spyOn(runtime, "getCollection").mockReturnValue([...mockEntries]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Query.published()", () => {
    it("filters to only published entries with status === 'published'", () => {
      const result = query("posts", { workflow: workflowConfig }).published().get();

      // Should include published-1, published-2 (not expired), but NOT scheduled-2 (future date)
      // or expired-1 (expired)
      const slugs = result.map((e) => e.slug);
      expect(slugs).toContain("published-1");
      expect(slugs).toContain("published-2");
      expect(slugs).not.toContain("draft-1");
      expect(slugs).not.toContain("scheduled-1");
      expect(slugs).not.toContain("scheduled-2"); // Future publishedAt
      expect(slugs).not.toContain("expired-1"); // Expired
    });

    it("respects publishedAt date filter", () => {
      const result = query("posts", { workflow: workflowConfig }).published().get();

      // scheduled-2 has status "published" but publishedAt is in the future
      const scheduledEntry = result.find((e) => e.slug === "scheduled-2");
      expect(scheduledEntry).toBeUndefined();
    });

    it("excludes expired entries when expirationField is configured", () => {
      const result = query("posts", { workflow: workflowConfig }).published().get();

      const expiredEntry = result.find((e) => e.slug === "expired-1");
      expect(expiredEntry).toBeUndefined();
    });

    it("includes entries with no expiration date", () => {
      const result = query("posts", { workflow: workflowConfig }).published().get();

      const entryWithoutExpiration = result.find((e) => e.slug === "published-1");
      expect(entryWithoutExpiration).toBeDefined();
    });

    it("uses default field names when workflow config is not provided", () => {
      // Default: statusField = "status", publishDateField = "publishedAt"
      const result = query("posts").published().get();

      expect(result.length).toBeGreaterThan(0);
      expect(result.every((e) => e.status === "published")).toBe(true);
    });
  });

  describe("Query.drafts()", () => {
    it("filters to only draft entries", () => {
      const result = query("posts", { workflow: workflowConfig }).drafts().get();

      expect(result).toHaveLength(2);
      expect(result.every((e) => e.status === "draft")).toBe(true);
      expect(result.map((e) => e.slug)).toEqual(["draft-1", "draft-2"]);
    });

    it("uses configured statusField", () => {
      const customConfig: WorkflowConfig = {
        statusField: "customStatus",
      };

      const customEntries: RuntimeEntry[] = [
        { ...createMockEntry("custom-1", "draft"), customStatus: "draft" },
        { ...createMockEntry("custom-2", "published"), customStatus: "published" },
      ];

      vi.spyOn(runtime, "getCollection").mockReturnValue(customEntries);

      const result = query("posts", { workflow: customConfig }).drafts().get();

      expect(result).toHaveLength(1);
      expect(nn(result[0]).slug).toBe("custom-1");
    });
  });

  describe("Query.scheduled()", () => {
    it("filters to entries with status 'scheduled'", () => {
      const result = query("posts", { workflow: workflowConfig }).scheduled().get();

      const scheduledEntry = result.find((e) => e.status === "scheduled");
      expect(scheduledEntry).toBeDefined();
      expect(scheduledEntry?.slug).toBe("scheduled-1");
    });

    it("includes entries with future publishedAt regardless of status", () => {
      const result = query("posts", { workflow: workflowConfig }).scheduled().get();

      // scheduled-2 has status "published" but future publishedAt
      const futurePublished = result.find((e) => e.slug === "scheduled-2");
      expect(futurePublished).toBeDefined();
    });

    it("excludes entries with past publishedAt and non-scheduled status", () => {
      const result = query("posts", { workflow: workflowConfig }).scheduled().get();

      const pastEntry = result.find((e) => e.slug === "published-1");
      expect(pastEntry).toBeUndefined();
    });
  });

  describe("Query with workflow methods chaining", () => {
    it("allows chaining published() with other query methods", () => {
      const result = query("posts", { workflow: workflowConfig })
        .published()
        .orderBy("publishedAt", "desc")
        .limit(1)
        .get();

      expect(result).toHaveLength(1);
      expect(nn(result[0]).status).toBe("published");
    });

    it("allows chaining drafts() with where clauses", () => {
      const result = query("posts", { workflow: workflowConfig })
        .drafts()
        .where("slug", "==", "draft-1")
        .get();

      expect(result).toHaveLength(1);
      expect(nn(result[0]).slug).toBe("draft-1");
    });

    it("works with paginate()", () => {
      const result = query("posts", { workflow: workflowConfig })
        .published()
        .paginate({ page: 1, perPage: 10 });

      expect(result.entries.every((e) => e.status === "published")).toBe(true);
      expect(result.pagination.total).toBe(2); // published-1, published-2
    });
  });

  describe("Edge cases", () => {
    it("handles entries without publishedAt field", () => {
      const entriesWithoutDates: RuntimeEntry[] = [
        {
          id: "posts/no-date",
          collection: "posts",
          file: { path: "no-date.md", fileName: "no-date", extension: "md", directory: ".", pathSegments: [], isIndex: false },
          slug: "no-date",
          status: "published",
          content: "",
        },
      ];

      vi.spyOn(runtime, "getCollection").mockReturnValue(entriesWithoutDates);

      const result = query("posts", { workflow: workflowConfig }).published().get();

      // Should include entry since it has no publishedAt to check
      expect(result).toHaveLength(1);
      expect(nn(result[0]).slug).toBe("no-date");
    });

    it("handles date strings instead of Date objects", () => {
      const entriesWithStringDates: RuntimeEntry[] = [
        {
          id: "posts/string-date",
          collection: "posts",
          file: { path: "string-date.md", fileName: "string-date", extension: "md", directory: ".", pathSegments: [], isIndex: false },
          slug: "string-date",
          status: "published",
          publishedAt: "2024-06-01T12:00:00Z", // String instead of Date
          content: "",
        },
      ];

      vi.spyOn(runtime, "getCollection").mockReturnValue(entriesWithStringDates);

      const result = query("posts", { workflow: workflowConfig }).published().get();

      expect(result).toHaveLength(1);
    });

    it("handles empty collection", () => {
      vi.spyOn(runtime, "getCollection").mockReturnValue([]);

      const published = query("posts", { workflow: workflowConfig }).published().get();
      const drafts = query("posts", { workflow: workflowConfig }).drafts().get();
      const scheduled = query("posts", { workflow: workflowConfig }).scheduled().get();

      expect(published).toHaveLength(0);
      expect(drafts).toHaveLength(0);
      expect(scheduled).toHaveLength(0);
    });

    it("handles workflow config without publishDateField", () => {
      const configWithoutPublishDate: WorkflowConfig = {
        statusField: "status",
        // No publishDateField
      };

      const result = query("posts", { workflow: configWithoutPublishDate }).published().get();

      // Should still filter by status and use default publishDateField
      expect(result.every((e) => e.status === "published")).toBe(true);
    });

    it("handles workflow config without expirationField", () => {
      const configWithoutExpiration: WorkflowConfig = {
        statusField: "status",
        publishDateField: "publishedAt",
        // No expirationField
      };

      const result = query("posts", { workflow: configWithoutExpiration }).published().get();

      // expired-1 should be included since we're not checking expiration
      const expiredEntry = result.find((e) => e.slug === "expired-1");
      expect(expiredEntry).toBeDefined();
    });
  });
});

describe("Runtime auto-filtering", () => {
  // Use dates that are clearly in the past or future relative to any reasonable "now"
  const pastDate = new Date("2020-01-01T12:00:00Z");
  const futureDate = new Date("2050-01-01T12:00:00Z");
  const expiredDate = new Date("2019-01-01T12:00:00Z");

  const mockEntries: RuntimeEntry[] = [
    {
      id: "posts/published",
      collection: "posts",
      file: { path: "published.md", fileName: "published", extension: "md", directory: ".", pathSegments: [], isIndex: false },
      slug: "published",
      status: "published",
      publishedAt: pastDate,
      content: "",
    },
    {
      id: "posts/draft",
      collection: "posts",
      file: { path: "draft.md", fileName: "draft", extension: "md", directory: ".", pathSegments: [], isIndex: false },
      slug: "draft",
      status: "draft",
      content: "",
    },
    {
      id: "posts/scheduled",
      collection: "posts",
      file: { path: "scheduled.md", fileName: "scheduled", extension: "md", directory: ".", pathSegments: [], isIndex: false },
      slug: "scheduled",
      status: "published",
      publishedAt: futureDate,
      content: "",
    },
    {
      id: "posts/expired",
      collection: "posts",
      file: { path: "expired.md", fileName: "expired", extension: "md", directory: ".", pathSegments: [], isIndex: false },
      slug: "expired",
      status: "published",
      publishedAt: pastDate,
      expiresAt: expiredDate,
      content: "",
    },
  ];

  beforeEach(() => {
    runtime.invalidateRuntimeEngine();
  });

  afterEach(() => {
    runtime.invalidateRuntimeEngine();
  });

  describe("getCollection with filterUnpublished", () => {
    it("filters unpublished content when filterUnpublished is true", () => {
      // Set up the data store
      runtime.setData({ posts: mockEntries });
      runtime.setWorkflowConfigs({
        posts: {
          statusField: "status",
          publishDateField: "publishedAt",
          expirationField: "expiresAt",
          filterUnpublished: true,
        },
      });

      const result = runtime.getCollection("posts");

      // Should only include published entry (not draft, scheduled, or expired)
      expect(result).toHaveLength(1);
      expect(nn(result[0]).slug).toBe("published");
    });

    it("returns all entries when filterUnpublished is false", () => {
      runtime.setData({ posts: mockEntries });
      runtime.setWorkflowConfigs({
        posts: {
          statusField: "status",
          filterUnpublished: false,
        },
      });

      const result = runtime.getCollection("posts");

      expect(result).toHaveLength(4);
    });

    it("returns all entries when no workflow config exists", () => {
      runtime.setData({ posts: mockEntries });
      runtime.setWorkflowConfigs({});

      const result = runtime.getCollection("posts");

      expect(result).toHaveLength(4);
    });
  });

  describe("getEntry with filterUnpublished", () => {
    it("returns published entry when filterUnpublished is true", () => {
      runtime.setData({ posts: mockEntries });
      runtime.setWorkflowConfigs({
        posts: {
          statusField: "status",
          publishDateField: "publishedAt",
          filterUnpublished: true,
        },
      });

      const entry = runtime.getEntry("posts", "published");
      expect(entry).toBeDefined();
      expect(entry?.slug).toBe("published");
    });

    it("returns undefined for draft entry when filterUnpublished is true", () => {
      runtime.setData({ posts: mockEntries });
      runtime.setWorkflowConfigs({
        posts: {
          statusField: "status",
          filterUnpublished: true,
        },
      });

      const entry = runtime.getEntry("posts", "draft");
      expect(entry).toBeUndefined();
    });

    it("returns undefined for scheduled entry when filterUnpublished is true", () => {
      runtime.setData({ posts: mockEntries });
      runtime.setWorkflowConfigs({
        posts: {
          statusField: "status",
          publishDateField: "publishedAt",
          filterUnpublished: true,
        },
      });

      const entry = runtime.getEntry("posts", "scheduled");
      expect(entry).toBeUndefined();
    });

    it("returns draft entry when filterUnpublished is false", () => {
      runtime.setData({ posts: mockEntries });
      runtime.setWorkflowConfigs({
        posts: {
          statusField: "status",
          filterUnpublished: false,
        },
      });

      const entry = runtime.getEntry("posts", "draft");
      expect(entry).toBeDefined();
      expect(entry?.slug).toBe("draft");
    });
  });

  describe("getWorkflowConfig", () => {
    it("returns workflow config for collection", () => {
      const config: runtime.CollectionWorkflowConfig = {
        posts: {
          statusField: "status",
          publishDateField: "publishedAt",
          filterUnpublished: true,
        },
      };

      runtime.setWorkflowConfigs(config);

      const result = runtime.getWorkflowConfig("posts");
      expect(result).toEqual(config.posts);
    });

    it("returns undefined for unknown collection", () => {
      runtime.setWorkflowConfigs({ posts: { statusField: "status" } });

      const result = runtime.getWorkflowConfig("unknown");
      expect(result).toBeUndefined();
    });

    it("returns undefined when no configs are set", () => {
      runtime.invalidateRuntimeEngine();

      const result = runtime.getWorkflowConfig("posts");
      expect(result).toBeUndefined();
    });
  });
});

describe("WorkflowConfig type", () => {
  it("supports all required and optional fields", () => {
    const fullConfig: WorkflowConfig = {
      statusField: "status",
      publishDateField: "publishedAt",
      expirationField: "expiresAt",
      filterUnpublished: true,
    };

    expect(fullConfig.statusField).toBe("status");
    expect(fullConfig.publishDateField).toBe("publishedAt");
    expect(fullConfig.expirationField).toBe("expiresAt");
    expect(fullConfig.filterUnpublished).toBe(true);
  });

  it("allows minimal config with only statusField", () => {
    const minimalConfig: WorkflowConfig = {
      statusField: "status",
    };

    expect(minimalConfig.statusField).toBe("status");
    expect(minimalConfig.publishDateField).toBeUndefined();
    expect(minimalConfig.expirationField).toBeUndefined();
    expect(minimalConfig.filterUnpublished).toBeUndefined();
  });
});
