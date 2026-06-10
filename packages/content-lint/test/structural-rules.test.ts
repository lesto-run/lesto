import { describe, expect, it } from "vitest";

import {
  checkNoEmphasisAsHeading,
  checkNoEmptyUrl,
  checkNoHeadingPunctuation,
  checkNoShellDollars,
  checkNoUndefinedReferences,
  createLineIndex,
} from "../src/index";

import type { Diagnostic } from "../src/index";

const run = (fn: typeof checkNoEmptyUrl, content: string): Diagnostic[] =>
  fn(content, "doc.md", createLineIndex(content));

describe("checkNoEmptyUrl", () => {
  it("flags a link with an empty URL", () => {
    const [d] = run(checkNoEmptyUrl, "[text]()");
    expect(d).toMatchObject({ rule: "noEmptyUrl", severity: "error" });
    expect(d?.message).toBe("Link has empty URL");
  });

  it("flags an image with an empty URL", () => {
    // The image regex is a superset of the link regex, so an empty-URL image
    // is reported by both passes; we assert the image-specific message exists.
    const diags = run(checkNoEmptyUrl, "![alt]()");
    expect(diags.some((d) => d.message === "Image has empty URL")).toBe(true);
    expect(diags.every((d) => d.rule === "noEmptyUrl")).toBe(true);
  });

  it("accepts links and images with real URLs", () => {
    expect(run(checkNoEmptyUrl, "[text](https://x.com)\n![alt](img.png)")).toEqual([]);
  });
});

describe("checkNoUndefinedReferences", () => {
  it("flags a full reference whose definition is missing", () => {
    const [d] = run(checkNoUndefinedReferences, "See [the docs][docs].");
    expect(d).toMatchObject({ rule: "noUndefinedReferences", severity: "error" });
    expect(d?.message).toBe("Undefined reference: [docs]");
  });

  it("accepts a full reference that is defined", () => {
    expect(
      run(checkNoUndefinedReferences, "See [the docs][docs].\n\n[docs]: https://x.com"),
    ).toEqual([]);
  });

  it("resolves a collapsed reference [text][] against its text", () => {
    // match[2] is empty, so the label falls back to match[1] ("docs").
    expect(run(checkNoUndefinedReferences, "[docs][]\n\n[docs]: https://x.com")).toEqual([]);
    const undef = run(checkNoUndefinedReferences, "[docs][]");
    expect(undef[0]?.message).toBe("Undefined reference: [docs]");
  });

  it("flags an undefined shortcut reference [ref]", () => {
    const [d] = run(checkNoUndefinedReferences, "Look at [missing] please.");
    expect(d?.message).toBe("Undefined reference: [missing]");
  });

  it("accepts a defined shortcut reference", () => {
    expect(run(checkNoUndefinedReferences, "Look at [here].\n\n[here]: https://x.com")).toEqual([]);
  });

  it("ignores task-list checkbox syntax [x], [X], and [ ]", () => {
    expect(run(checkNoUndefinedReferences, "- [x] done\n- [X] also\n- [ ] todo")).toEqual([]);
  });

  it("does not treat a reference definition line as a shortcut usage", () => {
    // "[here]" on the definition line is followed by ":"; the shortcut pass
    // must skip it via the afterMatch lookahead rather than flag it.
    expect(run(checkNoUndefinedReferences, "[here]: https://x.com")).toEqual([]);
  });

  it("does not flag an inline link as a shortcut reference", () => {
    // [text](url) is excluded by the shortcut pattern's negative lookahead.
    expect(run(checkNoUndefinedReferences, "[text](https://x.com)")).toEqual([]);
  });
});

describe("checkNoEmphasisAsHeading", () => {
  it("warns when bold text stands alone as a pseudo-heading followed by prose", () => {
    const content = "**Getting Started Guide**\n\nFollow these steps to begin.";
    const [d] = run(checkNoEmphasisAsHeading, content);
    expect(d).toMatchObject({ rule: "noEmphasisAsHeading", severity: "warning" });
    expect(d?.message).toMatch(/Don't use emphasis/);
    expect(d?.fix?.text).toBe("## Getting Started Guide");
  });

  it("handles triple-asterisk bold-italic emphasis as well", () => {
    const content = "***Getting Started Guide***\n\nFollow these steps to begin.";
    const [d] = run(checkNoEmphasisAsHeading, content);
    expect(d?.fix?.text).toBe("## Getting Started Guide");
  });

  it("ignores emphasis inside a bulleted list item", () => {
    const content = "- **Getting Started Guide**\n\nmore text here please";
    expect(run(checkNoEmphasisAsHeading, content)).toEqual([]);
  });

  it("ignores emphasis inside a numbered list item", () => {
    const content = "1. **Getting Started Guide**\n\nmore text here please";
    expect(run(checkNoEmphasisAsHeading, content)).toEqual([]);
  });

  it("ignores short emphasis that reads like an inline label", () => {
    const content = "**Note**\n\nsome following prose content here";
    expect(run(checkNoEmphasisAsHeading, content)).toEqual([]);
  });

  it("ignores emphasis that ends with a colon (a label like **Warning:**)", () => {
    const content = "**Important warning:**\n\nsome following prose content here";
    expect(run(checkNoEmphasisAsHeading, content)).toEqual([]);
  });

  it("does not warn when the next non-empty line is itself a heading", () => {
    // isHeadingLike is false because the following content is a real heading.
    const content = "**Getting Started Guide**\n\n# A Real Heading";
    expect(run(checkNoEmphasisAsHeading, content)).toEqual([]);
  });

  it("does not warn when nothing follows the emphasis", () => {
    // nextNonEmptyLine is undefined -> not heading-like.
    expect(run(checkNoEmphasisAsHeading, "**Getting Started Guide**")).toEqual([]);
  });
});

describe("checkNoHeadingPunctuation", () => {
  it("warns on a heading ending in a period and suggests trimming it", () => {
    const [d] = run(checkNoHeadingPunctuation, "## Installation steps.");
    expect(d).toMatchObject({ rule: "noHeadingPunctuation", severity: "warning" });
    expect(d?.message).toBe('Heading should not end with "."');
    expect(d?.fix?.text).toBe("## Installation steps");
  });

  it("warns on an exclamation mark", () => {
    const [d] = run(checkNoHeadingPunctuation, "## Welcome!");
    expect(d?.message).toBe('Heading should not end with "!"');
  });

  it("allows a question heading that starts with a question word", () => {
    expect(run(checkNoHeadingPunctuation, "## How do I install this?")).toEqual([]);
  });

  it("still flags a question mark when the heading is not a question word", () => {
    // Does not begin with a recognized interrogative, so the ? is flagged.
    const [d] = run(checkNoHeadingPunctuation, "## Installation complete?");
    expect(d?.message).toBe('Heading should not end with "?"');
  });

  it("leaves a clean heading alone", () => {
    expect(run(checkNoHeadingPunctuation, "## Installation")).toEqual([]);
  });
});

describe("checkNoShellDollars", () => {
  it("flags a $-prefixed command and suggests removing the prefix", () => {
    const [d] = run(checkNoShellDollars, "```bash\n$ npm install\n```");
    expect(d).toMatchObject({ rule: "noShellDollars", severity: "warning" });
    expect(d?.fix?.text).toBe("");
    // The fix range covers exactly the "$ " prefix.
    expect(d?.length).toBe(2);
  });

  it("flags an indented $-prefixed command starting after the indent", () => {
    const content = "```sh\n    $ make build\n```";
    const [d] = run(checkNoShellDollars, content);
    expect(d?.rule).toBe("noShellDollars");
    // The diagnostic should point past the four-space indent at the "$ " prefix.
    const { offset = 0, length = 0 } = d ?? {};
    expect(content.slice(offset, offset + length)).toBe("$ ");
  });

  it("flags each $ line independently in a multi-line block", () => {
    const diags = run(checkNoShellDollars, "```console\n$ one\n$ two\n```");
    expect(diags).toHaveLength(2);
  });

  it("leaves clean shell commands untouched", () => {
    expect(run(checkNoShellDollars, "```bash\nnpm install\n```")).toEqual([]);
  });

  it("ignores an empty shell block (no content to inspect)", () => {
    // The capture group is empty, so the rule short-circuits before scanning.
    expect(run(checkNoShellDollars, "```bash\n```")).toEqual([]);
  });
});
