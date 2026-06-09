import { describe, it, expect } from "vitest";
import { wordCount, readingTime, excerpt } from "../computed";
import type { RuntimeEntry } from "../types";

const createMockEntry = (content: string): RuntimeEntry & { content: string } => ({
  id: "posts/test-post",
  collection: "posts",
  file: {
    path: "test-post.md",
    fileName: "test-post",
    extension: "md",
    directory: "/test",
    pathSegments: ["test-post"],
    isIndex: false,
  },
  slug: "test-post",
  title: "Test Post",
  content,
});

describe("wordCount", () => {
  it("should count words correctly", () => {
    const entry = createMockEntry("Hello world this is a test");
    expect(wordCount(entry)).toBe(6);
  });

  it("should handle multiple spaces", () => {
    const entry = createMockEntry("Hello    world   test");
    expect(wordCount(entry)).toBe(3);
  });

  it("should handle empty content", () => {
    const entry = createMockEntry("");
    expect(wordCount(entry)).toBe(0);
  });

  it("should handle newlines", () => {
    const entry = createMockEntry("Hello\nworld\ntest");
    expect(wordCount(entry)).toBe(3);
  });
});

describe("readingTime", () => {
  it("should calculate reading time with default WPM (200)", () => {
    const content = Array.from({ length: 200 }, () => "word").join(" ");
    const entry = createMockEntry(content);
    expect(readingTime(entry)).toBe(1);
  });

  it("should round up reading time", () => {
    const content = Array.from({ length: 250 }, () => "word").join(" ");
    const entry = createMockEntry(content);
    expect(readingTime(entry)).toBe(2);
  });

  it("should accept custom WPM", () => {
    const content = Array.from({ length: 100 }, () => "word").join(" ");
    const entry = createMockEntry(content);
    expect(readingTime(entry, 100)).toBe(1);
  });

  it("should return at least 1 minute for short content", () => {
    const entry = createMockEntry("Just a few words");
    expect(readingTime(entry)).toBe(1);
  });
});

describe("excerpt", () => {
  it("should extract excerpt with default length (160)", () => {
    const content = "This is a test post. ".repeat(20);
    const entry = createMockEntry(content);
    const result = excerpt(entry);
    expect(result.length).toBeLessThanOrEqual(163); // 160 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("should respect word boundaries", () => {
    const content = "Hello world this is a very long piece of content";
    const entry = createMockEntry(content);
    const result = excerpt(entry, 20);
    expect(result).toBe("Hello world this is...");
  });

  it("should return full text if shorter than length", () => {
    const content = "Short text";
    const entry = createMockEntry(content);
    expect(excerpt(entry)).toBe("Short text");
  });

  it("should remove markdown headings", () => {
    const content = "# Heading\n## Subheading\nThis is the content";
    const entry = createMockEntry(content);
    const result = excerpt(entry);
    expect(result).toBe("Heading\nSubheading\nThis is the content");
  });

  it("should accept custom length", () => {
    const content = "This is a test post with some content.";
    const entry = createMockEntry(content);
    const result = excerpt(entry, 15);
    expect(result).toBe("This is a test...");
  });

  it("should handle content with no spaces", () => {
    const content = "a".repeat(200);
    const entry = createMockEntry(content);
    const result = excerpt(entry, 10);
    // When there are no spaces before the length limit, truncate at length and add ellipsis
    expect(result).toBe("a".repeat(10) + "...");
    expect(result.length).toBe(13);
  });
});
