import { describe, it, expect } from "vitest";
import { extract } from "./extract.js";

describe("extract", () => {
  it("extracts text from paragraphs", () => {
    const spans = extract("Hello world");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("Hello world");
    expect(spans[0]!.offset).toBe(0);
  });

  it("extracts text from headings", () => {
    const spans = extract("# Hello");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("Hello");
  });

  it("handles inline formatting", () => {
    const spans = extract("Hello **world**");
    const texts = spans.map((s) => s.text);
    // Both words are extracted (formatting markers stripped)
    expect(texts).toContain("Hello");
    expect(texts).toContain("world");
  });

  it("ignores code blocks", () => {
    const spans = extract("Hello\n\n```\ncode\n```\n\nWorld");
    const texts = spans.map((s) => s.text);
    expect(texts).toContain("Hello");
    expect(texts).toContain("World");
    expect(texts).not.toContain("code");
  });

  // Edge cases
  it("handles empty content", () => {
    const spans = extract("");
    expect(spans).toHaveLength(0);
  });

  it("handles content with only whitespace", () => {
    const spans = extract("   \n\n   ");
    expect(spans).toHaveLength(0);
  });

  it("handles file with no text nodes (only code)", () => {
    const spans = extract("```js\nconst x = 1;\n```");
    expect(spans).toHaveLength(0);
  });

  it("ignores inline code", () => {
    const spans = extract("Run `very important` command");
    const texts = spans.map((s) => s.text);
    expect(texts).toContain("Run");
    expect(texts).toContain("command");
    // Inline code should not be extracted
    expect(texts.join(" ")).not.toContain("very important");
  });

  it("extracts text from links", () => {
    const spans = extract("Click [very important](http://example.com) link");
    const texts = spans.map((s) => s.text);
    expect(texts).toContain("Click");
    expect(texts).toContain("very important");
    expect(texts).toContain("link");
  });

  it("extracts text from nested formatting", () => {
    const spans = extract("This is **bold and _italic_** text");
    const texts = spans.map((s) => s.text);
    // All prose words are extracted
    expect(texts.join(" ")).toContain("This");
    expect(texts.join(" ")).toContain("is");
    expect(texts.join(" ")).toContain("bold");
    expect(texts.join(" ")).toContain("italic");
    expect(texts.join(" ")).toContain("text");
  });

  it("extracts text from lists", () => {
    const spans = extract("- Item one\n- Item two");
    const texts = spans.map((s) => s.text);
    expect(texts).toContain("Item one");
    expect(texts).toContain("Item two");
  });

  it("extracts text from blockquotes", () => {
    const spans = extract("> This is quoted");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("This is quoted");
  });

  it("handles multiple headings", () => {
    const spans = extract("# H1\n\n## H2\n\n### H3");
    const texts = spans.map((s) => s.text);
    expect(texts).toEqual(["H1", "H2", "H3"]);
  });

  it("ignores HTML comments", () => {
    const spans = extract("Before <!-- comment --> After");
    const texts = spans.map((s) => s.text);
    expect(texts.join("")).not.toContain("comment");
  });

  it("handles fenced code blocks with language", () => {
    const spans = extract("Text\n\n```typescript\nconst very = true;\n```\n\nMore");
    const texts = spans.map((s) => s.text);
    expect(texts).toContain("Text");
    expect(texts).toContain("More");
    expect(texts.join("")).not.toContain("very");
  });

  it("preserves correct offsets for multiple paragraphs", () => {
    const md = "First\n\nSecond";
    const spans = extract(md);
    expect(spans[0]!.offset).toBe(0);
    expect(spans[1]!.offset).toBe(7);
    expect(md.slice(spans[1]!.offset)).toBe("Second");
  });

  it("preserves correct offsets when heading content matches prefix pattern", () => {
    // Regression test: "## ## ##" - the captured text "## ##" appears at position 0
    // but actually starts at position 3 (after the heading prefix)
    const md = "## ## ##";
    const spans = extract(md);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("## ##");
    expect(spans[0]!.offset).toBe(3); // After "## " prefix, not 0
    expect(md.slice(spans[0]!.offset)).toBe("## ##");
  });

  it("preserves correct offsets for list items with dash content", () => {
    // Similar case: "- - nested" where content starts with same char as prefix
    const md = "- - nested";
    const spans = extract(md);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("- nested");
    expect(spans[0]!.offset).toBe(2); // After "- " prefix
    expect(md.slice(spans[0]!.offset)).toBe("- nested");
  });

  it("handles pipe tables", () => {
    const md = "| Header |\n|--------|\n| Cell |";
    const spans = extract(md);
    const allText = spans.map((s) => s.text).join(" ");
    expect(allText).toContain("Header");
    expect(allText).toContain("Cell");
  });
});
