import { describe, it, expect } from "vitest";
import { nn } from "./test-utils";
import {
  buildRAGContext,
  formatContextForLLM,
  estimateTokens,
} from "../rag";
import type { RuntimeEntry } from "../types";

const createEntry = (
  slug: string,
  collection: string,
  data: Record<string, unknown> = {}
): RuntimeEntry => ({
  ...data,
  slug,
  content: data.content ?? `Content for ${slug}`,
  id: `${collection}/${slug}`,
  collection: collection,
  file: {
    path: `${slug}.md`,
    fileName: slug,
    extension: "md",
    directory: ".",
    pathSegments: [],
    isIndex: false,
  },
});

describe("RAG Context Primitives", () => {
  describe("estimateTokens", () => {
    it("returns 0 for empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("estimates tokens based on character count", () => {
      // ~4 characters per token
      const text = "Hello world"; // 11 chars
      expect(estimateTokens(text)).toBe(3); // ceil(11/4)
    });

    it("handles longer text", () => {
      const text = "This is a longer piece of text that should estimate more tokens.";
      // 64 chars -> 16 tokens
      expect(estimateTokens(text)).toBe(16); // ceil(64/4)
    });
  });

  describe("buildRAGContext", () => {
    it("builds context from entries", () => {
      const entries = [
        createEntry("doc-1", "docs", { title: "Getting Started", content: "Introduction content" }),
        createEntry("doc-2", "docs", { title: "API Reference", content: "API documentation" }),
      ];

      const context = buildRAGContext(entries);

      expect(context.entries).toHaveLength(2);
      expect(nn(context.entries[0]).title).toBe("Getting Started");
      expect(nn(context.entries[0]).content).toBe("Introduction content");
      expect(context.totalTokens).toBeGreaterThan(0);
      expect(context.truncated).toBe(false);
    });

    it("respects maxTokens limit", () => {
      const longContent = "A".repeat(1000);
      const entries = [
        createEntry("doc-1", "docs", { title: "Doc 1", content: longContent }),
        createEntry("doc-2", "docs", { title: "Doc 2", content: longContent }),
        createEntry("doc-3", "docs", { title: "Doc 3", content: longContent }),
      ];

      const context = buildRAGContext(entries, { maxTokens: 100 });

      expect(context.entries.length).toBeLessThan(entries.length);
      expect(context.totalTokens).toBeLessThanOrEqual(100);
      expect(context.truncated).toBe(true);
    });

    it("truncates content to excerptLength", () => {
      const longContent = "A".repeat(1000);
      const entries = [
        createEntry("doc-1", "docs", { title: "Doc 1", content: longContent }),
      ];

      const context = buildRAGContext(entries, {
        maxTokens: 10000,
        excerptLength: 100,
      });

      expect(nn(context.entries[0]).content.length).toBeLessThanOrEqual(103); // 100 + "..."
    });

    it("uses slug as title fallback", () => {
      const entries = [createEntry("my-document", "docs", { content: "Content" })];

      const context = buildRAGContext(entries);

      expect(nn(context.entries[0]).title).toBe("my-document");
    });

    it("supports custom titleField", () => {
      const entries = [
        createEntry("doc-1", "docs", { name: "Custom Title", content: "Content" }),
      ];

      const context = buildRAGContext(entries, { titleField: "name" });

      expect(nn(context.entries[0]).title).toBe("Custom Title");
    });

    it("excludes content when includeContent is false", () => {
      const entries = [
        createEntry("doc-1", "docs", { title: "Doc 1", content: "Some content" }),
      ];

      const context = buildRAGContext(entries, { includeContent: false });

      expect(nn(context.entries[0]).content).toBe("");
    });

    it("prioritizes by recency", () => {
      const entries = [
        createEntry("old", "docs", {
          title: "Old",
          publishedAt: new Date("2024-01-01"),
        }),
        createEntry("new", "docs", {
          title: "New",
          publishedAt: new Date("2024-12-01"),
        }),
      ];

      const context = buildRAGContext(entries, { prioritize: "recent" });

      expect(nn(context.entries[0]).title).toBe("New");
      expect(nn(context.entries[1]).title).toBe("Old");
    });

    it("prioritizes by exemplary status", () => {
      const entries = [
        createEntry("regular", "docs", { title: "Regular", featured: false }),
        createEntry("featured", "docs", { title: "Featured", featured: true }),
      ];

      const context = buildRAGContext(entries, { prioritize: "exemplary" });

      expect(nn(context.entries[0]).title).toBe("Featured");
      expect(nn(context.entries[1]).title).toBe("Regular");
    });

    it("handles empty entries", () => {
      const context = buildRAGContext([]);

      expect(context.entries).toHaveLength(0);
      expect(context.totalTokens).toBe(0);
      expect(context.truncated).toBe(false);
    });
  });

  describe("formatContextForLLM", () => {
    const createContext = () => {
      const entries = [
        createEntry("doc-1", "docs", {
          title: "Getting Started",
          content: "Introduction to the API",
        }),
        createEntry("guide-1", "guides", {
          title: "Best Practices",
          content: "Tips for success",
        }),
      ];
      return buildRAGContext(entries);
    };

    describe("markdown format", () => {
      it("formats as markdown with collection prefix", () => {
        const context = createContext();
        const formatted = formatContextForLLM(context, { format: "markdown" });

        expect(formatted).toContain("## [docs] Getting Started");
        expect(formatted).toContain("Introduction to the API");
        expect(formatted).toContain("## [guides] Best Practices");
      });

      it("omits collection when includeCollection is false", () => {
        const context = createContext();
        const formatted = formatContextForLLM(context, {
          format: "markdown",
          includeCollection: false,
        });

        expect(formatted).toContain("## Getting Started");
        expect(formatted).not.toContain("[docs]");
      });
    });

    describe("xml format", () => {
      it("formats as XML with collection attribute", () => {
        const context = createContext();
        const formatted = formatContextForLLM(context, { format: "xml" });

        expect(formatted).toContain("<context>");
        expect(formatted).toContain('collection="docs"');
        expect(formatted).toContain("<title>Getting Started</title>");
        expect(formatted).toContain("<content>Introduction to the API</content>");
        expect(formatted).toContain("</context>");
      });

      it("escapes XML special characters", () => {
        const entries = [
          createEntry("doc-1", "docs", {
            title: "A < B & C > D",
            content: 'Quote: "test"',
          }),
        ];
        const context = buildRAGContext(entries);
        const formatted = formatContextForLLM(context, { format: "xml" });

        expect(formatted).toContain("A &lt; B &amp; C &gt; D");
        expect(formatted).toContain("&quot;test&quot;");
      });
    });

    describe("json format", () => {
      it("formats as JSON with collection", () => {
        const context = createContext();
        const formatted = formatContextForLLM(context, { format: "json" });
        const parsed = JSON.parse(formatted);

        expect(parsed.entries).toHaveLength(2);
        expect(parsed.entries[0].title).toBe("Getting Started");
        expect(parsed.entries[0].collection).toBe("docs");
        expect(parsed.entries[0].content).toBe("Introduction to the API");
      });

      it("omits collection when includeCollection is false", () => {
        const context = createContext();
        const formatted = formatContextForLLM(context, {
          format: "json",
          includeCollection: false,
        });
        const parsed = JSON.parse(formatted);

        expect(parsed.entries[0].collection).toBeUndefined();
      });
    });

    it("handles empty context", () => {
      const context = buildRAGContext([]);

      expect(formatContextForLLM(context, { format: "markdown" })).toBe(
        "No relevant content available."
      );
      expect(formatContextForLLM(context, { format: "xml" })).toBe(
        "<context>No relevant content available.</context>"
      );
    });

    it("defaults to markdown format", () => {
      const context = createContext();
      const formatted = formatContextForLLM(context);

      expect(formatted).toContain("##");
      expect(formatted).not.toContain("<context>");
    });
  });
});
