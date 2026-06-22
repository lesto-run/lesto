import { describe, it, expect } from "vitest";
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import { createRenderer } from "../renderer";
import { rehypeCallouts, CALLOUT_TYPES } from "../callouts";

/** Run a raw HTML fragment through just the callouts plugin (no md4w/sanitize). */
async function transform(html: string): Promise<string> {
  const file = await unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeCallouts)
    .use(rehypeStringify)
    .process(html);
  return String(file);
}

describe("rehypeCallouts (plugin)", () => {
  it("turns a [!NOTE] blockquote into a callout with a title and body", async () => {
    const html = await transform("<blockquote><p>[!NOTE]\nBody text.</p></blockquote>");

    expect(html).toContain('<div class="lesto-callout lesto-callout-note" role="note">');
    expect(html).toContain('<p class="lesto-callout-title">');
    expect(html).toContain('<span class="lesto-callout-icon" aria-hidden="true">ℹ</span>');
    expect(html).toContain("Note");
    expect(html).toContain("Body text.");
    expect(html).not.toContain("[!NOTE]");
    expect(html).not.toContain("<blockquote");
  });

  it("recognizes every documented type, case-insensitively", async () => {
    for (const [type, meta] of Object.entries(CALLOUT_TYPES)) {
      const upper = type.toUpperCase();
      const html = await transform(`<blockquote><p>[!${upper}]\nx</p></blockquote>`);
      expect(html).toContain(`lesto-callout-${type}`);
      expect(html).toContain(meta.glyph);
      expect(html).toContain(meta.label);
    }
  });

  it("drops the empty paragraph left by a bare marker", async () => {
    const html = await transform("<blockquote><p>[!TIP]</p><p>Real body.</p></blockquote>");

    expect(html).toContain("lesto-callout-tip");
    expect(html).toContain("Real body.");
    // No empty <p></p> should survive from the stripped marker line.
    expect(html).not.toContain("<p></p>");
  });

  it("leaves an ordinary blockquote untouched", async () => {
    const html = await transform("<blockquote><p>Just a quote.</p></blockquote>");

    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("lesto-callout");
  });

  it("ignores an unrecognized marker type", async () => {
    const html = await transform("<blockquote><p>[!FOOBAR]\ntext</p></blockquote>");

    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("lesto-callout");
    // The marker is preserved verbatim since it was not a real callout.
    expect(html).toContain("[!FOOBAR]");
  });

  it("does not treat a marker with trailing same-line text as a callout", async () => {
    // GitHub requires the marker to be alone on its line.
    const html = await transform("<blockquote><p>[!NOTE] inline text</p></blockquote>");

    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("lesto-callout");
  });

  it("ignores a blockquote whose first child is not a paragraph", async () => {
    const html = await transform("<blockquote><ul><li>[!NOTE]</li></ul></blockquote>");

    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("lesto-callout");
  });
});

describe("callouts via createRenderer (md4w hybrid, default-on)", () => {
  it("renders a [!WARNING] callout end-to-end", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("> [!WARNING]\n> Heads up: this is destructive.");

    expect(result.html).toContain("lesto-callout lesto-callout-warning");
    expect(result.html).toContain("Warning");
    expect(result.html).toContain("Heads up: this is destructive.");
    expect(result.html).not.toContain("[!WARNING]");
  });

  it("leaves a plain blockquote as a blockquote", async () => {
    const renderer = createRenderer();
    const result = await renderer.render("> An ordinary quote.");

    expect(result.html).toContain("<blockquote");
    expect(result.html).not.toContain("lesto-callout");
  });

  it("can be disabled with callouts: false", async () => {
    const renderer = createRenderer({ callouts: false });
    const result = await renderer.render("> [!NOTE]\n> Body.");

    expect(result.html).not.toContain("lesto-callout");
    expect(result.html).toContain("[!NOTE]");
  });
});
