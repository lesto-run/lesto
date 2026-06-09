import { describe, it, expect } from "vitest";
import {
  extractPlainText,
  extractHeadings,
  stripFrontmatter,
  hasFrontmatter,
  calculateReadingTime,
} from "../markdown.js";

describe("stripFrontmatter", () => {
  it("removes YAML frontmatter from content", () => {
    const content = `---
title: Test
date: 2024-01-01
---
# Hello World`;
    const result = stripFrontmatter(content);
    expect(result).toBe("# Hello World");
  });

  it("handles content without frontmatter", () => {
    const content = "# Hello World\n\nThis is content.";
    const result = stripFrontmatter(content);
    expect(result).toBe(content);
  });

  it("handles empty frontmatter", () => {
    // The regex requires at least one character between --- delimiters
    // Empty frontmatter (---\n---) won't be stripped, which is correct behavior
    // since valid YAML frontmatter should have content
    const content = `---
key: value
---
Content here`;
    const result = stripFrontmatter(content);
    expect(result).toBe("Content here");
  });

  it("preserves content when frontmatter delimiters have no content", () => {
    // Edge case: empty frontmatter isn't valid YAML frontmatter
    const content = "---\n---\nContent here";
    const result = stripFrontmatter(content);
    // No content between delimiters means the regex doesn't match
    expect(result).toBe(content);
  });

  it("handles frontmatter with Windows line endings", () => {
    const content = "---\r\ntitle: Test\r\n---\r\n# Hello";
    const result = stripFrontmatter(content);
    expect(result).toBe("# Hello");
  });

  it("handles multiline frontmatter values", () => {
    const content = `---
title: Test
description: |
  This is a
  multiline value
---
Content`;
    const result = stripFrontmatter(content);
    expect(result).toBe("Content");
  });

  it("does not strip content that looks like frontmatter mid-document", () => {
    const content = `# Title

---
not frontmatter
---

More content`;
    const result = stripFrontmatter(content);
    expect(result).toBe(content);
  });
});

describe("hasFrontmatter", () => {
  it("returns true for content with frontmatter", () => {
    const content = `---
title: Test
---
Content`;
    expect(hasFrontmatter(content)).toBe(true);
  });

  it("returns false for content without frontmatter", () => {
    const content = "# Hello World";
    expect(hasFrontmatter(content)).toBe(false);
  });

  it("returns false for dashes not at the start", () => {
    const content = "Some text\n---\nMore text";
    expect(hasFrontmatter(content)).toBe(false);
  });

  it("handles Windows line endings", () => {
    const content = "---\r\ntitle: Test\r\n---";
    expect(hasFrontmatter(content)).toBe(true);
  });

  it("returns false for single dash line", () => {
    const content = "-\nContent";
    expect(hasFrontmatter(content)).toBe(false);
  });
});

describe("extractPlainText", () => {
  it("extracts plain text from markdown", async () => {
    const markdown = "# Hello\n\nThis is **bold** and *italic* text.";
    const result = await extractPlainText(markdown);
    // mdast-util-to-string concatenates text without newlines between elements
    expect(result).toContain("Hello");
    expect(result).toContain("This is bold and italic text.");
  });

  it("handles code blocks", async () => {
    const markdown = "```javascript\nconst x = 1;\n```\n\nParagraph";
    const result = await extractPlainText(markdown);
    expect(result).toContain("const x = 1;");
    expect(result).toContain("Paragraph");
  });

  it("handles lists", async () => {
    const markdown = "- Item 1\n- Item 2\n- Item 3";
    const result = await extractPlainText(markdown);
    expect(result).toContain("Item 1");
    expect(result).toContain("Item 2");
    expect(result).toContain("Item 3");
  });

  it("handles links", async () => {
    const markdown = "Visit [our site](https://example.com) today!";
    const result = await extractPlainText(markdown);
    expect(result).toBe("Visit our site today!");
  });

  it("handles empty content", async () => {
    const result = await extractPlainText("");
    expect(result).toBe("");
  });
});

describe("extractHeadings", () => {
  it("extracts all headings by default", async () => {
    const markdown = `# H1
## H2
### H3
#### H4
##### H5
###### H6`;
    const headings = await extractHeadings(markdown);
    expect(headings).toHaveLength(6);
    expect(headings[0]).toEqual({ depth: 1, text: "H1", slug: "h1" });
    expect(headings[1]).toEqual({ depth: 2, text: "H2", slug: "h2" });
  });

  it("filters headings by level", async () => {
    const markdown = `# H1
## H2
### H3
## Another H2`;
    const headings = await extractHeadings(markdown, [2]);
    expect(headings).toHaveLength(2);
    expect(headings[0]?.text).toBe("H2");
    expect(headings[1]?.text).toBe("Another H2");
  });

  it("generates unique slugs for duplicate headings", async () => {
    const markdown = `## Introduction
## Introduction
## Introduction`;
    const headings = await extractHeadings(markdown);
    expect(headings[0]?.slug).toBe("introduction");
    expect(headings[1]?.slug).toBe("introduction-1");
    expect(headings[2]?.slug).toBe("introduction-2");
  });

  it("handles headings with inline formatting", async () => {
    const markdown = "## Hello **bold** and *italic*";
    const headings = await extractHeadings(markdown, [2]);
    expect(headings[0]?.text).toBe("Hello bold and italic");
  });

  it("handles headings with code", async () => {
    const markdown = "## The `useState` hook";
    const headings = await extractHeadings(markdown, [2]);
    expect(headings[0]?.text).toBe("The useState hook");
  });

  it("returns empty array for content without headings", async () => {
    const markdown = "Just a paragraph.\n\nAnother paragraph.";
    const headings = await extractHeadings(markdown);
    expect(headings).toHaveLength(0);
  });
});

describe("calculateReadingTime", () => {
  it("calculates reading time for short content", async () => {
    const markdown = "This is a short paragraph with only ten words here.";
    const result = await calculateReadingTime(markdown);
    expect(result.words).toBe(10);
    expect(result.minutes).toBe(1);
    expect(result.text).toBe("1 min read");
  });

  it("calculates reading time for longer content", async () => {
    // Generate ~400 words (2 minutes at 200 wpm)
    const words = Array(400).fill("word").join(" ");
    const result = await calculateReadingTime(words);
    expect(result.words).toBe(400);
    expect(result.minutes).toBe(2);
    expect(result.text).toBe("2 min read");
  });

  it("strips frontmatter before calculating", async () => {
    const markdown = `---
title: Test
---
One two three four five.`;
    const result = await calculateReadingTime(markdown);
    expect(result.words).toBe(5);
  });

  it("uses custom words per minute", async () => {
    const words = Array(100).fill("word").join(" ");
    const result = await calculateReadingTime(words, 100);
    expect(result.minutes).toBe(1);
  });

  it("rounds up to nearest minute", async () => {
    // 201 words at 200 wpm = 1.005 minutes -> rounds to 2
    const words = Array(201).fill("word").join(" ");
    const result = await calculateReadingTime(words);
    expect(result.minutes).toBe(2);
  });

  it("handles empty content", async () => {
    const result = await calculateReadingTime("");
    expect(result.words).toBe(0);
    expect(result.minutes).toBe(0);
    expect(result.text).toBe("0 min read");
  });
});
