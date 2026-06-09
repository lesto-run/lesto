import { describe, it, expect } from "vitest";
import { generateLlmsTxt } from "../llms-txt";
import type { FeedEntry } from "../feeds";
import type { RuntimeEntry } from "../types";

const createEntry = (
  slug: string,
  collection: string,
  data: Record<string, unknown> = {},
): RuntimeEntry & FeedEntry => ({
  ...data,
  slug,
  content: "",
  id: `${collection}/${slug}`,
  collection: collection,
  file: {
    path: `${slug}.md`,
    fileName: slug,
    extension: "md",
    directory: ".",
    pathSegments: [slug],
    isIndex: false,
  },
});

describe("llms-txt", () => {
  describe("generateLlmsTxt", () => {
    it("generates H1 heading with project name", () => {
      const txt = generateLlmsTxt([], {
        name: "My Documentation",
        siteUrl: "https://example.com",
      });

      expect(txt).toContain("# My Documentation");
    });

    it("includes blockquote description when provided", () => {
      const txt = generateLlmsTxt([], {
        name: "Docs",
        description: "Comprehensive API documentation",
        siteUrl: "https://example.com",
      });

      expect(txt).toContain("> Comprehensive API documentation");
    });

    it("includes overview text after blockquote", () => {
      const txt = generateLlmsTxt([], {
        name: "Docs",
        description: "Short summary",
        overview: "This documentation covers all aspects of the API.",
        siteUrl: "https://example.com",
      });

      const lines = txt.split("\n");
      const blockquoteIndex = lines.findIndex((l) => l.startsWith(">"));
      const overviewIndex = lines.findIndex((l) => l.includes("This documentation covers"));

      expect(blockquoteIndex).toBeGreaterThan(-1);
      expect(overviewIndex).toBeGreaterThan(blockquoteIndex);
    });

    it("groups entries by collection with H2 headings", () => {
      const entries = [
        createEntry("getting-started", "docs", { title: "Getting Started" }),
        createEntry("api-reference", "docs", { title: "API Reference" }),
        createEntry("best-practices", "guides", { title: "Best Practices" }),
      ];

      const txt = generateLlmsTxt(entries, {
        name: "My Docs",
        siteUrl: "https://example.com",
      });

      expect(txt).toContain("## Docs");
      expect(txt).toContain("## Guides");
    });

    it("formats entries as markdown links with descriptions", () => {
      const entries = [
        createEntry("intro", "docs", {
          title: "Introduction",
          description: "Getting started with the API",
        }),
      ];

      const txt = generateLlmsTxt(entries, {
        name: "Docs",
        siteUrl: "https://example.com",
      });

      expect(txt).toContain(
        "- [Introduction](https://example.com/docs/intro): Getting started with the API",
      );
    });

    it("formats entries without descriptions correctly", () => {
      const entries = [createEntry("intro", "docs", { title: "Introduction" })];

      const txt = generateLlmsTxt(entries, {
        name: "Docs",
        siteUrl: "https://example.com",
      });

      expect(txt).toContain("- [Introduction](https://example.com/docs/intro)");
      expect(txt).not.toContain("Introduction):");
    });

    it("uses slug as fallback title", () => {
      const entries = [createEntry("my-page", "docs")];

      const txt = generateLlmsTxt(entries, {
        name: "Docs",
        siteUrl: "https://example.com",
      });

      expect(txt).toContain("[my-page]");
    });

    it("supports custom field names", () => {
      const entries = [
        createEntry("test", "docs", {
          name: "Custom Title",
          summary: "Custom description",
        }),
      ];

      const txt = generateLlmsTxt(entries, {
        name: "Docs",
        siteUrl: "https://example.com",
        titleField: "name",
        descriptionField: "summary",
      });

      expect(txt).toContain("[Custom Title]");
      expect(txt).toContain(": Custom description");
    });

    it("supports custom collection names", () => {
      const entries = [createEntry("test", "api-reference", { title: "Test" })];

      const txt = generateLlmsTxt(entries, {
        name: "Docs",
        siteUrl: "https://example.com",
        collectionNames: {
          "api-reference": "API Documentation",
        },
      });

      expect(txt).toContain("## API Documentation");
    });

    it("supports custom URL generator", () => {
      const entries = [createEntry("test", "docs", { title: "Test" })];

      const txt = generateLlmsTxt(entries, {
        name: "Docs",
        siteUrl: "https://example.com",
        urlGenerator: (entry) => `https://example.com/${entry.slug}.md`,
      });

      expect(txt).toContain("(https://example.com/test.md)");
    });

    it("removes trailing slash from siteUrl", () => {
      const entries = [createEntry("test", "docs", { title: "Test" })];

      const txt = generateLlmsTxt(entries, {
        name: "Docs",
        siteUrl: "https://example.com/",
      });

      expect(txt).toContain("https://example.com/docs/test");
      expect(txt).not.toContain("example.com//docs");
    });

    it("can disable collection grouping", () => {
      const entries = [
        createEntry("a", "docs", { title: "A" }),
        createEntry("b", "guides", { title: "B" }),
      ];

      const txt = generateLlmsTxt(entries, {
        name: "Docs",
        siteUrl: "https://example.com",
        groupByCollection: false,
      });

      expect(txt).toContain("## Content");
      expect(txt).not.toContain("## Docs");
      expect(txt).not.toContain("## Guides");
    });

    it("includes custom sections", () => {
      const txt = generateLlmsTxt([], {
        name: "Docs",
        siteUrl: "https://example.com",
        sections: [
          {
            heading: "Resources",
            entries: [
              { title: "GitHub", path: "https://github.com/example/repo" },
              {
                title: "Discord",
                path: "https://discord.gg/example",
                description: "Join our community",
              },
            ],
          },
        ],
      });

      expect(txt).toContain("## Resources");
      expect(txt).toContain("[GitHub](https://github.com/example/repo)");
      expect(txt).toContain("[Discord](https://discord.gg/example): Join our community");
    });

    it("includes Optional section with semantic meaning", () => {
      const txt = generateLlmsTxt([], {
        name: "Docs",
        siteUrl: "https://example.com",
        optionalSection: {
          heading: "Optional",
          entries: [
            {
              title: "Changelog",
              path: "https://example.com/changelog",
              description: "Historical changes",
            },
          ],
        },
      });

      expect(txt).toContain("## Optional");
      expect(txt).toContain("[Changelog](https://example.com/changelog)");
    });

    it("does not include Optional section when empty", () => {
      const txt = generateLlmsTxt([], {
        name: "Docs",
        siteUrl: "https://example.com",
        optionalSection: {
          heading: "Optional",
          entries: [],
        },
      });

      expect(txt).not.toContain("## Optional");
    });

    it("handles empty entries array", () => {
      const txt = generateLlmsTxt([], {
        name: "Empty Docs",
        description: "No content yet",
        siteUrl: "https://example.com",
      });

      expect(txt).toContain("# Empty Docs");
      expect(txt).toContain("> No content yet");
      expect(txt).not.toContain("## Content");
    });

    it("title cases collection names by default", () => {
      const entries = [
        createEntry("test", "api-reference", { title: "Test" }),
        createEntry("test2", "user_guides", { title: "Test 2" }),
      ];

      const txt = generateLlmsTxt(entries, {
        name: "Docs",
        siteUrl: "https://example.com",
      });

      expect(txt).toContain("## Api Reference");
      expect(txt).toContain("## User Guides");
    });

    it("ends with single newline", () => {
      const txt = generateLlmsTxt([], {
        name: "Docs",
        siteUrl: "https://example.com",
      });

      expect(txt.endsWith("\n")).toBe(true);
      expect(txt.endsWith("\n\n")).toBe(false);
    });

    it("produces valid llms.txt format", () => {
      const entries = [
        createEntry("getting-started", "docs", {
          title: "Getting Started",
          description: "Quick start guide",
        }),
        createEntry("api", "docs", {
          title: "API Reference",
          description: "Complete API documentation",
        }),
        createEntry("deployment", "guides", {
          title: "Deployment",
          description: "How to deploy to production",
        }),
      ];

      const txt = generateLlmsTxt(entries, {
        name: "MyApp Documentation",
        description: "Comprehensive documentation for MyApp API and SDK",
        overview: "MyApp provides a powerful API for building integrations.",
        siteUrl: "https://docs.myapp.com",
        sections: [
          {
            heading: "Resources",
            entries: [{ title: "GitHub", path: "https://github.com/myapp/sdk" }],
          },
        ],
        optionalSection: {
          heading: "Optional",
          entries: [
            {
              title: "Changelog",
              path: "https://docs.myapp.com/changelog",
              description: "Version history",
            },
          ],
        },
      });

      // Verify structure follows spec
      const lines = txt.split("\n");

      // First non-empty line should be H1
      const h1Line = lines.find((l) => l.trim().length > 0);
      expect(h1Line).toBe("# MyApp Documentation");

      // Should have blockquote
      expect(txt).toContain("> Comprehensive documentation");

      // Should have H2 sections for collections
      expect(txt).toContain("## Docs");
      expect(txt).toContain("## Guides");

      // Should have custom section
      expect(txt).toContain("## Resources");

      // Should have Optional section at end
      expect(txt).toContain("## Optional");
      const optionalIndex = txt.indexOf("## Optional");
      const resourcesIndex = txt.indexOf("## Resources");
      expect(optionalIndex).toBeGreaterThan(resourcesIndex);
    });
  });
});
