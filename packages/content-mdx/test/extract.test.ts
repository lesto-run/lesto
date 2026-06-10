import { describe, expect, it } from "vitest";
import type { Root, PhrasingContent } from "mdast";
import type { VFile } from "vfile";

import {
  calculateReadingTime,
  extractTextFromChildren,
  generateExcerpt,
  normalizePlugins,
  remarkExtractHeadings,
  resolveRawContent,
} from "../src/extract";
import type { Heading } from "../src/types";

// ---------------------------------------------------------------------------
// extractTextFromChildren — flattens a heading's inline tree to plain text.
// ---------------------------------------------------------------------------

describe("extractTextFromChildren", () => {
  it("joins plain text and inline code, recursing into nested marks", () => {
    const children: PhrasingContent[] = [
      { type: "text", value: "Use " },
      { type: "inlineCode", value: "compileMDX" },
      { type: "text", value: " in " },
      {
        type: "strong",
        children: [{ type: "text", value: "bold" }],
      },
    ];

    expect(extractTextFromChildren(children)).toBe("Use compileMDX in bold");
  });

  it("contributes nothing for a node that is neither text, code, nor a parent", () => {
    // An image is a leaf with no `value`/`children` we read — it adds "".
    const children: PhrasingContent[] = [
      { type: "text", value: "see " },
      { type: "image", url: "/x.png", alt: "x" },
    ];

    expect(extractTextFromChildren(children)).toBe("see ");
  });

  it("flattens deeply nested phrasing across multiple levels", () => {
    const children: PhrasingContent[] = [
      {
        type: "emphasis",
        children: [
          { type: "text", value: "a" },
          {
            type: "link",
            url: "/x",
            children: [{ type: "text", value: "b" }],
          },
        ],
      },
    ];

    expect(extractTextFromChildren(children)).toBe("ab");
  });
});

// ---------------------------------------------------------------------------
// remarkExtractHeadings — records headings into file.data with stable slugs.
// ---------------------------------------------------------------------------

/** A minimal VFile stand-in: the transformer only ever touches `.data`. */
function makeFile(): VFile {
  return { data: {} } as unknown as VFile;
}

function heading(depth: number, ...children: PhrasingContent[]) {
  return { type: "heading" as const, depth, children };
}

describe("remarkExtractHeadings", () => {
  it("captures depth, text, and a slug for each heading", () => {
    const tree = {
      type: "root",
      children: [
        heading(1, { type: "text", value: "Getting Started" }),
        heading(2, { type: "text", value: "Install & Run" }),
      ],
    } as unknown as Root;

    const file = makeFile();

    remarkExtractHeadings()(tree, file);

    expect(file.data["headings"]).toEqual([
      { depth: 1, text: "Getting Started", slug: "getting-started" },
      { depth: 2, text: "Install & Run", slug: "install--run" },
    ]);
  });

  it("disambiguates duplicate heading text with -1, -2 suffixes", () => {
    const tree = {
      type: "root",
      children: [
        heading(2, { type: "text", value: "Notes" }),
        heading(2, { type: "text", value: "Notes" }),
        heading(2, { type: "text", value: "Notes" }),
      ],
    } as unknown as Root;

    const file = makeFile();

    remarkExtractHeadings()(tree, file);

    const slugs = (file.data["headings"] as Heading[]).map((h) => h.slug);

    expect(slugs).toEqual(["notes", "notes-1", "notes-2"]);
  });

  it("reads inline code and nested marks inside a heading", () => {
    const tree = {
      type: "root",
      children: [
        heading(
          3,
          { type: "inlineCode", value: "useMemo" },
          { type: "text", value: " hook " },
          { type: "strong", children: [{ type: "text", value: "deps" }] },
        ),
      ],
    } as unknown as Root;

    const file = makeFile();

    remarkExtractHeadings()(tree, file);

    expect(file.data["headings"]).toEqual([
      { depth: 3, text: "useMemo hook deps", slug: "usememo-hook-deps" },
    ]);
  });

  it("contributes nothing for a heading child that is a bare leaf node", () => {
    // A heading consisting only of an image yields no text -> it is dropped.
    const tree = {
      type: "root",
      children: [heading(2, { type: "image", url: "/x.png", alt: "x" })],
    } as unknown as Root;

    const file = makeFile();

    remarkExtractHeadings()(tree, file);

    expect(file.data["headings"]).toEqual([]);
  });

  it("trims surrounding whitespace before slugging", () => {
    const tree = {
      type: "root",
      children: [heading(1, { type: "text", value: "  Spaced  " })],
    } as unknown as Root;

    const file = makeFile();

    remarkExtractHeadings()(tree, file);

    expect(file.data["headings"]).toEqual([{ depth: 1, text: "Spaced", slug: "spaced" }]);
  });
});

// ---------------------------------------------------------------------------
// normalizePlugins — coerce nothing / one / many into a list.
// ---------------------------------------------------------------------------

/** A stand-in pluggable; identity is all these tests care about. */
const noopPlugin = () => undefined;

describe("normalizePlugins", () => {
  it("returns an empty array for null and undefined", () => {
    expect(normalizePlugins(null)).toEqual([]);
    expect(normalizePlugins(undefined)).toEqual([]);
  });

  it("wraps a single pluggable in an array", () => {
    expect(normalizePlugins(noopPlugin)).toEqual([noopPlugin]);
  });

  it("passes an existing array through unchanged", () => {
    const plugins = [() => 1, () => 2];

    expect(normalizePlugins(plugins)).toBe(plugins);
  });
});

// ---------------------------------------------------------------------------
// calculateReadingTime — whitespace word count, round-up minutes.
// ---------------------------------------------------------------------------

describe("calculateReadingTime", () => {
  it('reports "< 1 min read" for empty / whitespace-only content', () => {
    expect(calculateReadingTime("", 250)).toEqual({
      words: 0,
      minutes: 0,
      text: "< 1 min read",
    });

    expect(calculateReadingTime("   \n\t  ", 250)).toEqual({
      words: 0,
      minutes: 0,
      text: "< 1 min read",
    });
  });

  it("rounds a short post up to a single minute", () => {
    expect(calculateReadingTime("one two three", 250)).toEqual({
      words: 3,
      minutes: 1,
      text: "1 min read",
    });
  });

  it("rounds up partial minutes for a longer post", () => {
    const content = Array.from({ length: 501 }, (_, i) => `w${i}`).join(" ");

    // 501 words / 250 wpm = 2.004 -> ceil -> 3.
    expect(calculateReadingTime(content, 250)).toEqual({
      words: 501,
      minutes: 3,
      text: "3 min read",
    });
  });

  it("collapses arbitrary whitespace runs when counting words", () => {
    expect(calculateReadingTime("a\n\n  b\t c", 250).words).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// resolveRawContent — prefer matter.content, then source, then "".
// ---------------------------------------------------------------------------

describe("resolveRawContent", () => {
  it("prefers the bundler's stripped matter content", () => {
    expect(resolveRawContent("body text", "raw source")).toBe("body text");
  });

  it("treats an empty-string matter content as present (not nullish)", () => {
    // "" is a valid body — it must NOT fall through to source.
    expect(resolveRawContent("", "raw source")).toBe("");
  });

  it("falls back to source when matter content is undefined", () => {
    expect(resolveRawContent(undefined, "raw source")).toBe("raw source");
  });

  it("falls back to an empty string when both are undefined", () => {
    expect(resolveRawContent(undefined, undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// generateExcerpt — strip markup, truncate on a word boundary.
// ---------------------------------------------------------------------------

describe("generateExcerpt", () => {
  it("returns short content whole, with markup stripped", () => {
    const content = "# Title\n\nA **bold** word and a [link](https://x.com) here.";

    // `#+\s` strips the "# " marker but keeps the heading text inline.
    expect(generateExcerpt(content, 200)).toBe("Title A bold word and a link here.");
  });

  it("strips a leading frontmatter block", () => {
    const content = "---\ntitle: Hello\ndate: 2026-01-01\n---\nThe body begins.";

    expect(generateExcerpt(content, 200)).toBe("The body begins.");
  });

  it("truncates at a word boundary and appends an ellipsis", () => {
    const content = "alpha beta gamma delta epsilon zeta eta theta";

    // length 20 lands mid-"epsilon"; the trailing partial word is dropped.
    const excerpt = generateExcerpt(content, 20);

    expect(excerpt).toBe("alpha beta gamma...");
    expect(excerpt.endsWith("...")).toBe(true);
  });

  it("collapses newlines and removes emphasis/code/strike marks", () => {
    const content = "line one\nline `two`\n\n_three_ ~four~";

    expect(generateExcerpt(content, 200)).toBe("line one line two three four");
  });

  it("returns content exactly at the boundary length unchanged", () => {
    const content = "exactly ten"; // 11 chars

    expect(generateExcerpt(content, 11)).toBe("exactly ten");
  });
});
