import { describe, expect, it } from "vitest";

import {
  checkAltText,
  checkCodeBlocks,
  checkEmbeds,
  checkHeadings,
  checkLinks,
  createLineIndex,
} from "../src/index";

import type { Diagnostic } from "../src/index";

// Each checker takes (content, file, lineIndex). This helper keeps the call
// sites focused on the markdown being exercised, not the plumbing.
const run = (fn: typeof checkAltText, content: string): Diagnostic[] =>
  fn(content, "doc.md", createLineIndex(content));

describe("checkAltText", () => {
  it("flags a markdown image with empty alt text as an error", () => {
    const [d, ...rest] = run(checkAltText, "![](cat.png)");
    expect(rest).toHaveLength(0);
    expect(d).toMatchObject({ rule: "altText", severity: "error" });
    expect(d?.message).toMatch(/missing alt text/);
    expect(d?.help).toMatch(/Add descriptive alt text/);
  });

  it("accepts a markdown image that has alt text", () => {
    expect(run(checkAltText, "![a tabby cat](cat.png)")).toEqual([]);
  });

  it("flags an HTML <img> with no alt attribute at all", () => {
    const [d] = run(checkAltText, '<img src="cat.png" />');
    expect(d).toMatchObject({ rule: "altText", severity: "error" });
    expect(d?.message).toMatch(/HTML image missing alt attribute/);
  });

  it("accepts an HTML <img> that carries a non-empty alt attribute", () => {
    // The non-empty alt means it is neither the missing-alt nor empty-alt case.
    expect(run(checkAltText, '<img src="cat.png" alt="a cat" />')).toEqual([]);
  });

  it("flags an HTML <img> whose alt attribute is empty", () => {
    const [d] = run(checkAltText, '<img src="cat.png" alt="" />');
    expect(d).toMatchObject({ rule: "altText", severity: "error" });
    expect(d?.message).toMatch(/empty alt text/);
  });
});

describe("checkHeadings", () => {
  it("passes a clean, sequential hierarchy with unique titles", () => {
    expect(run(checkHeadings, "# Title\n\n## A\n\n### B\n\n## C")).toEqual([]);
  });

  it("flags a second H1 as an error and leaves the first alone", () => {
    const diags = run(checkHeadings, "# First\n\n# Second");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ rule: "headingHierarchy", severity: "error" });
    expect(diags[0]?.message).toMatch(/Multiple H1/);
  });

  it("flags a skipped heading level (H2 -> H4)", () => {
    const diags = run(checkHeadings, "## Section\n\n#### Deep");
    expect(diags).toHaveLength(1);
    expect(diags[0]?.message).toBe("Heading level skipped from H2 to H4");
    expect(diags[0]?.help).toMatch(/Use H3 instead of H4/);
  });

  it("does not flag a one-step increase or a decrease in level", () => {
    expect(run(checkHeadings, "## A\n\n### B\n\n## C")).toEqual([]);
  });

  it("warns on a duplicate same-level heading but not the first occurrence", () => {
    const diags = run(checkHeadings, "## Setup\n\n## Setup");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ rule: "headingDuplicate", severity: "warning" });
    expect(diags[0]?.message).toMatch(/Duplicate H2 heading: "Setup"/);
  });

  it("treats same text at different levels as distinct", () => {
    expect(run(checkHeadings, "## Setup\n\n### Setup")).toEqual([]);
  });

  it("matches duplicate titles case-insensitively", () => {
    const diags = run(checkHeadings, "## Setup\n\n## SETUP");
    expect(diags).toHaveLength(1);
    expect(diags[0]?.rule).toBe("headingDuplicate");
  });

  it("strips closed-ATX trailing hashes when reading the heading text", () => {
    // "## Setup ##" and "## Setup" should collide as the same title.
    const diags = run(checkHeadings, "## Setup ##\n\n## Setup");
    expect(diags).toHaveLength(1);
    expect(diags[0]?.rule).toBe("headingDuplicate");
  });
});

describe("checkLinks", () => {
  it("warns on vague link text", () => {
    const [d] = run(checkLinks, "[click here](https://example.com)");
    expect(d).toMatchObject({ rule: "linkText", severity: "warning" });
    expect(d?.message).toBe('Vague link text: "click here"');
  });

  it("matches vague text case-insensitively and trims whitespace", () => {
    const [d] = run(checkLinks, "[  Read More  ](https://example.com)");
    expect(d?.rule).toBe("linkText");
  });

  it("accepts descriptive link text", () => {
    expect(run(checkLinks, "[the setup guide](https://example.com)")).toEqual([]);
  });
});

describe("checkCodeBlocks", () => {
  it("warns on an opening fence with no language", () => {
    const diags = run(checkCodeBlocks, "```\ncode\n```");
    // Only the opening fence (even count before it) is flagged, not the close.
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ rule: "codeBlockLanguage", severity: "warning" });
  });

  it("accepts a fence that declares a language", () => {
    expect(run(checkCodeBlocks, "```ts\ncode\n```")).toEqual([]);
  });

  it("flags only opening fences across multiple blocks", () => {
    const diags = run(checkCodeBlocks, "```\na\n```\n\n```\nb\n```");
    expect(diags).toHaveLength(2);
  });
});

describe("checkEmbeds", () => {
  it("flags an iframe without a title as an error", () => {
    const [d] = run(checkEmbeds, '<iframe src="https://x.com"></iframe>');
    expect(d).toMatchObject({ rule: "embedTitle", severity: "error" });
    expect(d?.message).toMatch(/iframe missing title/);
  });

  it("accepts an iframe that has a title", () => {
    expect(run(checkEmbeds, '<iframe src="x" title="Tutorial"></iframe>')).toEqual([]);
  });

  it("warns on a video element without a title", () => {
    const [d] = run(checkEmbeds, '<video src="clip.mp4"></video>');
    expect(d).toMatchObject({ rule: "embedTitle", severity: "warning" });
    expect(d?.message).toMatch(/video element missing title/);
  });

  it("accepts a video element that has a title", () => {
    expect(run(checkEmbeds, '<video src="clip.mp4" title="Demo"></video>')).toEqual([]);
  });
});
