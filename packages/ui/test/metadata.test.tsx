import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  dedupeMetadata,
  link,
  meta,
  renderMetadata,
  renderMetadataEntry,
  title,
} from "../src/index";
import type { MetadataEntry } from "../src/index";

describe("metadata element helpers", () => {
  it("title renders a <title>", () => {
    expect(renderToStaticMarkup(title("Estates"))).toBe("<title>Estates</title>");
  });

  it("meta renders a named meta", () => {
    expect(renderToStaticMarkup(meta({ name: "description", content: "Find a home" }))).toBe(
      '<meta name="description" content="Find a home"/>',
    );
  });

  it("meta renders an og:property meta", () => {
    expect(renderToStaticMarkup(meta({ property: "og:title", content: "Estates" }))).toBe(
      '<meta property="og:title" content="Estates"/>',
    );
  });

  it("meta renders a charset meta", () => {
    expect(renderToStaticMarkup(meta({ charSet: "utf-8" }))).toBe('<meta charSet="utf-8"/>');
  });

  it("link renders a bare rel/href link", () => {
    expect(renderToStaticMarkup(link({ rel: "canonical", href: "/p/1" }))).toBe(
      '<link rel="canonical" href="/p/1"/>',
    );
  });

  it("link carries every optional attribute when present", () => {
    const html = renderToStaticMarkup(
      link({
        rel: "alternate",
        href: "/es",
        hrefLang: "es",
        type: "text/html",
        sizes: "any",
        media: "(min-width: 600px)",
      }),
    );

    // React emits the DOM-property casing `hrefLang` in static markup.
    expect(html).toContain('hrefLang="es"');
    expect(html).toContain('type="text/html"');
    expect(html).toContain('sizes="any"');
    expect(html).toContain('media="(min-width: 600px)"');
  });
});

describe("dedupeMetadata — singletons keep the last value", () => {
  it("collapses duplicate titles to the last one", () => {
    const entries: MetadataEntry[] = [
      { kind: "title", text: "Layout default" },
      { kind: "title", text: "Page title" },
    ];

    expect(dedupeMetadata(entries)).toEqual([{ kind: "title", text: "Page title" }]);
  });

  it("collapses duplicate meta names, properties, and charset", () => {
    const entries: MetadataEntry[] = [
      { kind: "meta", spec: { charSet: "latin-1" } },
      { kind: "meta", spec: { charSet: "utf-8" } },
      { kind: "meta", spec: { name: "description", content: "old" } },
      { kind: "meta", spec: { name: "description", content: "new" } },
      { kind: "meta", spec: { property: "og:title", content: "old" } },
      { kind: "meta", spec: { property: "og:title", content: "new" } },
    ];

    expect(dedupeMetadata(entries)).toEqual([
      { kind: "meta", spec: { charSet: "utf-8" } },
      { kind: "meta", spec: { name: "description", content: "new" } },
      { kind: "meta", spec: { property: "og:title", content: "new" } },
    ]);
  });

  it("keeps distinct meta names side by side", () => {
    const entries: MetadataEntry[] = [
      { kind: "meta", spec: { name: "description", content: "d" } },
      { kind: "meta", spec: { name: "robots", content: "index" } },
    ];

    expect(dedupeMetadata(entries)).toHaveLength(2);
  });

  it("treats rel=canonical as a singleton but lets other links repeat", () => {
    const entries: MetadataEntry[] = [
      { kind: "link", spec: { rel: "canonical", href: "/a" } },
      { kind: "link", spec: { rel: "canonical", href: "/b" } },
      { kind: "link", spec: { rel: "stylesheet", href: "/a.css" } },
      { kind: "link", spec: { rel: "stylesheet", href: "/b.css" } },
    ];

    expect(dedupeMetadata(entries)).toEqual([
      // Only the last canonical survives; both stylesheets stay.
      { kind: "link", spec: { rel: "canonical", href: "/b" } },
      { kind: "link", spec: { rel: "stylesheet", href: "/a.css" } },
      { kind: "link", spec: { rel: "stylesheet", href: "/b.css" } },
    ]);
  });

  it("collapses an exact-duplicate non-canonical link but keeps hreflang variants apart", () => {
    const entries: MetadataEntry[] = [
      { kind: "link", spec: { rel: "alternate", href: "/x", hrefLang: "en" } },
      { kind: "link", spec: { rel: "alternate", href: "/x", hrefLang: "es" } },
      // Exact duplicate of the first (same rel+href+hrefLang) — collapses.
      { kind: "link", spec: { rel: "alternate", href: "/x", hrefLang: "en" } },
    ];

    expect(dedupeMetadata(entries)).toEqual([
      { kind: "link", spec: { rel: "alternate", href: "/x", hrefLang: "en" } },
      { kind: "link", spec: { rel: "alternate", href: "/x", hrefLang: "es" } },
    ]);
  });

  it("preserves first-seen order while applying the last value", () => {
    const entries: MetadataEntry[] = [
      { kind: "title", text: "first" },
      { kind: "meta", spec: { name: "description", content: "d" } },
      { kind: "title", text: "second" },
    ];

    // Title keeps its FIRST position but its LAST value.
    expect(dedupeMetadata(entries)).toEqual([
      { kind: "title", text: "second" },
      { kind: "meta", spec: { name: "description", content: "d" } },
    ]);
  });

  it("promotes a late-declared charset to the FRONT of the head", () => {
    // A deeply nested component declares charset last. The HTML spec demands it
    // lead the head (within the first ~1024 bytes), so dedupe hoists it ahead of
    // the title and description rather than leaving it in its first-seen slot.
    const entries: MetadataEntry[] = [
      { kind: "title", text: "Page" },
      { kind: "meta", spec: { name: "description", content: "d" } },
      { kind: "meta", spec: { charSet: "utf-8" } },
    ];

    expect(dedupeMetadata(entries)).toEqual([
      { kind: "meta", spec: { charSet: "utf-8" } },
      { kind: "title", text: "Page" },
      { kind: "meta", spec: { name: "description", content: "d" } },
    ]);
  });

  it("keeps charset first and still applies its LAST value when re-declared", () => {
    // Declared first AND overridden later: it stays first (its singleton slot) and
    // takes the winning value — promotion and last-wins are independent.
    const entries: MetadataEntry[] = [
      { kind: "meta", spec: { charSet: "latin-1" } },
      { kind: "title", text: "Page" },
      { kind: "meta", spec: { charSet: "utf-8" } },
    ];

    expect(dedupeMetadata(entries)).toEqual([
      { kind: "meta", spec: { charSet: "utf-8" } },
      { kind: "title", text: "Page" },
    ]);
  });

  it("leaves order untouched when no charset is present", () => {
    // The promotion branch must not perturb the no-charset path.
    const entries: MetadataEntry[] = [
      { kind: "title", text: "Page" },
      { kind: "meta", spec: { name: "description", content: "d" } },
    ];

    expect(dedupeMetadata(entries)).toEqual([
      { kind: "title", text: "Page" },
      { kind: "meta", spec: { name: "description", content: "d" } },
    ]);
  });
});

describe("renderMetadataEntry", () => {
  it("renders each entry kind with its key", () => {
    expect(renderToStaticMarkup(renderMetadataEntry({ kind: "title", text: "T" }, "m0"))).toBe(
      "<title>T</title>",
    );

    expect(
      renderToStaticMarkup(
        renderMetadataEntry({ kind: "meta", spec: { name: "x", content: "y" } }, "m1"),
      ),
    ).toBe('<meta name="x" content="y"/>');

    expect(
      renderToStaticMarkup(
        renderMetadataEntry({ kind: "link", spec: { rel: "canonical", href: "/c" } }, "m2"),
      ),
    ).toBe('<link rel="canonical" href="/c"/>');
  });
});

describe("renderMetadata", () => {
  it("dedupes then renders the surviving tags, hoisted by React", () => {
    const entries: MetadataEntry[] = [
      { kind: "title", text: "old" },
      { kind: "title", text: "new" },
      { kind: "meta", spec: { name: "description", content: "d" } },
    ];

    const html = renderToStaticMarkup(<>{renderMetadata(entries)}</>);

    // One title (the last value), one meta — no duplicate <title> shipped.
    expect(html).toBe('<title>new</title><meta name="description" content="d"/>');
    expect([...html.matchAll(/<title>/g)]).toHaveLength(1);
  });
});
