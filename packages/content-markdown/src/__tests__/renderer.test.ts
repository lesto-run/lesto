import { describe, it, expect } from "vitest";
import type { Node } from "unist";
import type { Plugin } from "unified";
import { createRenderer, createUnifiedRenderer } from "../renderer";

// Hoisted to module scope: these plugins capture no variables from their
// parent scope, so recreating them per-test is unnecessary.
const remarkTestPlugin: Plugin = () => (tree: Node) => {
  // Just verify it doesn't throw
  return tree;
};

const rehypeTestPlugin: Plugin = () => (tree: Node) => tree;

describe("createRenderer", () => {
  it("renders basic markdown to HTML", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("## Hello\n\nWorld");

    expect(result.html).toContain("<h2");
    expect(result.html).toContain("Hello");
    expect(result.html).toContain("<p>World</p>");
  });

  it("adds IDs to headings via rehype-slug", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("## Hello World");

    expect(result.html).toContain('id="hello-world"');
  });

  it("strips first H1 by default", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("# Title\n\n## Section\n\nContent");

    expect(result.html).not.toContain("<h1");
    expect(result.html).toContain("<h2");
    expect(result.html).toContain("Section");
    expect(result.html).toContain("<p>Content</p>");
  });

  it("preserves first H1 when stripFirstHeading is false", async () => {
    const renderer = createRenderer({ stripFirstHeading: false });
    const result = await renderer.render("# Title\n\n## Section");

    expect(result.html).toContain("<h1");
    expect(result.html).toContain("Title");
    expect(result.html).toContain("<h2");
  });

  it("only strips the first H1, not subsequent ones", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("# First\n\n## Section\n\n# Second");

    expect(result.html).not.toContain("First");
    expect(result.html).toContain("<h1");
    expect(result.html).toContain("Second");
  });

  it("renders GFM tables", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("| a | b |\n|---|---|\n| 1 | 2 |");

    expect(result.html).toContain("<table>");
    expect(result.html).toContain("<th>a</th>");
    expect(result.html).toContain("<td>1</td>");
  });

  it("renders GFM strikethrough", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("~~deleted~~");

    expect(result.html).toContain("<del>deleted</del>");
  });

  it("renders bold text", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("**bold**");

    expect(result.html).toContain("<strong>bold</strong>");
  });

  it("renders links", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("[link](https://example.com)");

    expect(result.html).toContain('<a href="https://example.com">link</a>');
  });

  it("renders code blocks", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("```js\nconst x = 1;\n```");

    // rehype-pretty-code wraps in figure and adds attributes to pre/code
    expect(result.html).toContain("<pre");
    expect(result.html).toContain("<code");
    expect(result.html).toContain("const x = 1;");
  });

  it("accepts custom remark plugins", async () => {
    const renderer = createRenderer({ remarkPlugins: [remarkTestPlugin] });
    const result = await renderer.render("Hello");

    expect(result.html).toContain("<p>Hello</p>");
  });

  it("accepts custom rehype plugins", async () => {
    const renderer = createRenderer({ rehypePlugins: [rehypeTestPlugin] });
    const result = await renderer.render("Hello");

    expect(result.html).toContain("<p>Hello</p>");
  });
});

describe("createUnifiedRenderer sanitization (fallback path)", () => {
  // The unified renderer is the fallback used when md4w WASM init fails in the
  // hybrid renderer. It must sanitize on this path too — defense-in-depth must
  // hold on EVERY render path, not just the primary md4w one.
  it("strips <script> tags from rendered output", async () => {
    const renderer = createUnifiedRenderer();
    const result = await renderer.render("Hello\n\n<script>alert('xss')</script>\n\nWorld");

    expect(result.html.toLowerCase()).not.toContain("<script");
    expect(result.html).toContain("Hello");
    expect(result.html).toContain("World");
  });

  it("strips dangerous javascript: link hrefs", async () => {
    // This is load-bearing on rehype-sanitize specifically: without it, a
    // markdown link survives remark-rehype and renders the javascript: href.
    const renderer = createUnifiedRenderer();
    const result = await renderer.render("[click me](javascript:alert(1))");

    expect(result.html.toLowerCase()).not.toContain("javascript:");
    expect(result.html).toContain("click me");
  });

  it("preserves heading IDs through sanitization", async () => {
    // The shared sanitizeSchema must allow `id`, so rehype-slug's heading IDs
    // survive the sanitize pass that now runs before it.
    const renderer = createUnifiedRenderer();
    const result = await renderer.render("## Hello World");

    expect(result.html).toContain('id="hello-world"');
  });
});

describe("headings extraction", () => {
  it("extracts headings from markdown", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("## One\n### Two\n## Three");

    expect(result.headings).toHaveLength(3);
    expect(result.headings[0]).toEqual({
      depth: 2,
      text: "One",
      slug: "one",
    });
    expect(result.headings[1]).toEqual({
      depth: 3,
      text: "Two",
      slug: "two",
    });
    expect(result.headings[2]).toEqual({
      depth: 2,
      text: "Three",
      slug: "three",
    });
  });

  it("excludes h1 by default", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("# Title\n## Section");

    expect(result.headings).toHaveLength(1);
    expect(result.headings[0]?.depth).toBe(2);
  });

  it("respects custom heading levels", async () => {
    const renderer = createRenderer({ headingLevels: [1, 2] });
    const result = await renderer.render("# One\n## Two\n### Three");

    expect(result.headings).toHaveLength(2);
    expect(result.headings[0]?.depth).toBe(1);
    expect(result.headings[1]?.depth).toBe(2);
  });

  it("slugifies headings correctly", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("## Hello World\n## Test & More");

    expect(result.headings[0]?.slug).toBe("hello-world");
    // & becomes a dash, so "Test & More" -> "test--more"
    expect(result.headings[1]?.slug).toBe("test--more");
  });
});

describe("reading time", () => {
  it("calculates reading time for short text", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("Hello world");

    expect(result.readingTime.words).toBe(2);
    expect(result.readingTime.minutes).toBe(1);
  });

  it("calculates reading time for longer text", async () => {
    const renderer = createRenderer();
    const words = "word ".repeat(500);
    const result = await renderer.render(words);

    expect(result.readingTime.words).toBe(500);
    expect(result.readingTime.minutes).toBe(2); // 500/250 = 2
  });

  it("respects custom words per minute", async () => {
    const renderer = createRenderer({ wordsPerMinute: 100 });
    const words = "word ".repeat(500);
    const result = await renderer.render(words);

    expect(result.readingTime.minutes).toBe(5); // 500/100 = 5
  });

  it("excludes code blocks from word count", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("One two\n```\nlots of code words here\n```\nthree");

    // Only "One two three" should be counted
    expect(result.readingTime.words).toBe(3);
  });
});

describe("excerpt", () => {
  it("generates excerpt from markdown", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("This is a test paragraph.");

    expect(result.excerpt).toBe("This is a test paragraph.");
  });

  it("strips heading syntax", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("# Title\n\nContent here.");

    expect(result.excerpt).not.toContain("#");
    expect(result.excerpt).toContain("Title");
    expect(result.excerpt).toContain("Content here.");
  });

  it("strips bold and italic", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("**bold** and *italic* text");

    expect(result.excerpt).toBe("bold and italic text");
  });

  it("extracts link text", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("[link text](https://example.com)");

    expect(result.excerpt).toBe("link text");
  });

  it("truncates at word boundary", async () => {
    const renderer = createRenderer({ excerptLength: 20 });
    const result = await renderer.render("This is a longer paragraph that should be truncated.");

    expect(result.excerpt.length).toBeLessThanOrEqual(23); // 20 + "..."
    expect(result.excerpt.endsWith("...")).toBe(true);
  });

  it("removes frontmatter", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("---\ntitle: Test\n---\nContent here.");

    expect(result.excerpt).not.toContain("title");
    expect(result.excerpt).toBe("Content here.");
  });
});

describe("edge cases", () => {
  describe("empty and minimal content", () => {
    it("handles empty string", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("");

      expect(result.html).toBe("");
      expect(result.headings).toEqual([]);
      expect(result.readingTime).toEqual({ minutes: 0, words: 0, text: "0 min read" });
      expect(result.excerpt).toBe("");
    });

    it("handles whitespace-only content", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("   \n\n   \t   ");

      expect(result.headings).toEqual([]);
      expect(result.readingTime.words).toBe(0);
      expect(result.excerpt.trim()).toBe("");
    });

    it("handles only frontmatter (no content)", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("---\ntitle: Test\nauthor: John\n---");

      expect(result.excerpt).toBe("");
      expect(result.headings).toEqual([]);
    });

    it("handles single character", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("a");

      expect(result.html).toContain("<p>a</p>");
      expect(result.readingTime.words).toBe(1);
      expect(result.excerpt).toBe("a");
    });
  });

  describe("headings edge cases", () => {
    it("ignores headings inside code blocks", async () => {
      const renderer = createRenderer({ headingLevels: [1, 2, 3] });
      const result = await renderer.render(
        "## Real Heading\n```\n## Fake Heading\n```\n## Another Real",
      );

      expect(result.headings).toHaveLength(2);
      expect(result.headings[0]?.text).toBe("Real Heading");
      expect(result.headings[1]?.text).toBe("Another Real");
    });

    it("handles headings with inline code", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("## Using `useState` Hook");

      expect(result.headings[0]?.text).toBe("Using `useState` Hook");
      expect(result.headings[0]?.slug).toBe("using-usestate-hook");
    });

    it("handles headings with emojis", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("## Getting Started 🚀");

      expect(result.headings[0]?.text).toBe("Getting Started 🚀");
      // Emoji should be stripped from slug
      expect(result.headings[0]?.slug).toBe("getting-started-");
    });

    it("handles headings with unicode characters", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("## Привет мир\n## 你好世界");

      expect(result.headings).toHaveLength(2);
      expect(result.headings[0]?.text).toBe("Привет мир");
      expect(result.headings[1]?.text).toBe("你好世界");
    });

    it("handles duplicate headings", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("## Section\n## Section\n## Section");

      expect(result.headings).toHaveLength(3);
      // Slugs should be unique (github-slugger appends -1, -2 for duplicates)
      expect(result.headings[0]?.slug).toBe("section");
      expect(result.headings[1]?.slug).toBe("section-1");
      expect(result.headings[2]?.slug).toBe("section-2");
    });

    it("handles headings without space after #", async () => {
      const renderer = createRenderer();
      // This is invalid markdown - should not be extracted
      const result = await renderer.render("##NoSpace");

      expect(result.headings).toHaveLength(0);
    });

    it("handles heading with only special characters", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("## @#$%^&*");

      expect(result.headings[0]?.text).toBe("@#$%^&*");
      // All special chars stripped, just dashes remain
      expect(result.headings[0]?.slug).toBe("");
    });

    it("extracts all 6 heading levels when configured", async () => {
      const renderer = createRenderer({ headingLevels: [1, 2, 3, 4, 5, 6] });
      const result = await renderer.render("# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6");

      expect(result.headings).toHaveLength(6);
      expect(result.headings.map((h) => h.depth)).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe("excerpt edge cases", () => {
    it("handles content with only code blocks", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("```js\nconst x = 1;\n```");

      // Code is stripped, excerpt should be empty or minimal
      expect(result.excerpt).toBe("");
    });

    it("handles content with only images", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("![alt text](image.png)");

      expect(result.excerpt).toBe("");
    });

    it("handles nested markdown formatting", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("***bold and italic*** text");

      expect(result.excerpt).toBe("bold and italic text");
    });

    it("handles inline code in excerpt", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("Use `npm install` to install");

      // Inline code is stripped
      expect(result.excerpt).toBe("Use  to install");
    });

    it("handles blockquotes", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("> This is a quote");

      // Blockquote markers should be preserved in excerpt (basic implementation)
      expect(result.excerpt).toContain("This is a quote");
    });

    it("handles very long single word", async () => {
      const renderer = createRenderer({ excerptLength: 10 });
      const longWord = "a".repeat(50);
      const result = await renderer.render(longWord);

      // Should truncate even without word boundary
      expect(result.excerpt.length).toBeLessThanOrEqual(13);
      expect(result.excerpt.endsWith("...")).toBe(true);
    });

    it("handles excerpt exactly at length limit", async () => {
      const renderer = createRenderer({ excerptLength: 11 });
      const result = await renderer.render("Hello World");

      // Exactly 11 chars, should not truncate
      expect(result.excerpt).toBe("Hello World");
      expect(result.excerpt.endsWith("...")).toBe(false);
    });
  });

  describe("reading time edge cases", () => {
    it("handles content with multiple code blocks", async () => {
      const renderer = createRenderer();
      const result = await renderer.render(
        "Word1\n```\ncode block 1\n```\nWord2\n```\ncode block 2\n```\nWord3",
      );

      expect(result.readingTime.words).toBe(3);
    });

    it("handles very long content", async () => {
      const renderer = createRenderer();
      const words = "word ".repeat(10000);
      const result = await renderer.render(words);

      expect(result.readingTime.words).toBe(10000);
      expect(result.readingTime.minutes).toBe(40); // 10000/250 = 40
    });

    it("rounds up reading time", async () => {
      const renderer = createRenderer({ wordsPerMinute: 100 });
      const result = await renderer.render("word ".repeat(101));

      // 101/100 = 1.01, should round up to 2
      expect(result.readingTime.minutes).toBe(2);
    });

    it("handles content with only code", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("```\nconst x = 1;\nconst y = 2;\n```");

      expect(result.readingTime.words).toBe(0);
      expect(result.readingTime.minutes).toBe(0);
    });
  });

  describe("HTML rendering edge cases", () => {
    it("escapes HTML in content", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("<script>alert('xss')</script>");

      // Should not contain raw script tag
      expect(result.html).not.toContain("<script>");
    });

    it("handles HTML entities", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("&amp; &lt; &gt; &quot;");

      // Entities may be converted to numeric equivalents (&#x26; = &amp;)
      expect(result.html).toMatch(/&amp;|&#x26;|&/);
    });

    it("handles deeply nested lists", async () => {
      const renderer = createRenderer();
      const result = await renderer.render(
        "- Level 1\n  - Level 2\n    - Level 3\n      - Level 4",
      );

      expect(result.html).toContain("<ul>");
      expect(result.html).toContain("<li>");
    });

    it("handles task lists (GFM)", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("- [ ] Unchecked\n- [x] Checked");

      expect(result.html).toContain('type="checkbox"');
    });

    it("handles footnotes style links", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("[link][1]\n\n[1]: https://example.com");

      expect(result.html).toContain('href="https://example.com"');
    });

    it("handles autolinks (GFM)", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("Visit https://example.com for more");

      expect(result.html).toContain('href="https://example.com"');
    });
  });

  describe("renderer reuse", () => {
    it("can render multiple documents with same renderer", async () => {
      const renderer = createRenderer();

      const result1 = await renderer.render("## Doc 1");
      const result2 = await renderer.render("## Doc 2");
      const result3 = await renderer.render("## Doc 3");

      expect(result1.html).toContain("Doc 1");
      expect(result2.html).toContain("Doc 2");
      expect(result3.html).toContain("Doc 3");
    });

    it("maintains isolation between renders", async () => {
      const renderer = createRenderer();

      // Render with heading
      const result1 = await renderer.render("## Heading 1");
      // Render without heading
      const result2 = await renderer.render("No heading here");

      expect(result1.headings).toHaveLength(1);
      expect(result2.headings).toHaveLength(0);
    });
  });

  describe("special markdown patterns", () => {
    it("handles horizontal rules", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("Above\n\n---\n\nBelow");

      expect(result.html).toContain("<hr");
    });

    it("handles line breaks", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("Line 1  \nLine 2");

      expect(result.html).toContain("<br");
    });

    it("handles definition lists style content", async () => {
      const renderer = createRenderer();
      const result = await renderer.render("Term\n: Definition");

      // Standard markdown doesn't support definition lists, should render as text
      expect(result.html).toContain("Term");
      expect(result.html).toContain("Definition");
    });

    it("handles mixed content types", async () => {
      const renderer = createRenderer();
      const complexMd = `
# Title

Paragraph with **bold** and *italic*.

## Code Example

\`\`\`javascript
const x = 1;
\`\`\`

| Column 1 | Column 2 |
|----------|----------|
| Cell 1   | Cell 2   |

- List item 1
- List item 2

> Blockquote

[Link](https://example.com)
`;

      const result = await renderer.render(complexMd);

      // H1 is stripped by default
      expect(result.html).not.toContain("<h1");
      expect(result.html).toContain("<h2");
      expect(result.html).toContain("<strong>");
      expect(result.html).toContain("<em>");
      expect(result.html).toContain("<pre"); // rehype-pretty-code adds attributes
      expect(result.html).toContain("<table>");
      expect(result.html).toContain("<ul>");
      expect(result.html).toContain("<blockquote>");
      expect(result.html).toContain("<a ");
    });
  });
});
