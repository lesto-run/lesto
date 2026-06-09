import { describe, expect, it } from "vitest";

import type { FeedItem, FeedMeta } from "../src/types";

import { atom } from "../src/atom";
import { FeedError, KeelError } from "../src/errors";
import { rss } from "../src/rss";
import { escapeXml } from "../src/xml";

describe("escapeXml", () => {
  it("escapes the five predefined XML entities", () => {
    expect(escapeXml(`& < > " '`)).toBe(`&amp; &lt; &gt; &quot; &apos;`);
  });

  it("escapes ampersand before introducing new entities (no double-escape)", () => {
    expect(escapeXml("a & b < c")).toBe("a &amp; b &lt; c");
  });

  it("leaves plain text untouched", () => {
    expect(escapeXml("plain text")).toBe("plain text");
  });

  it("refuses a non-string runtime value with a stable code", () => {
    // A caller bypassed the type system at runtime; the cast simulates that.
    const bad = 42 as unknown as string;

    try {
      escapeXml(bad);
      expect.unreachable("escapeXml should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FeedError);
      expect(error).toBeInstanceOf(KeelError);
      expect((error as FeedError).code).toBe("FEED_UNESCAPABLE_VALUE");
      expect((error as FeedError).details).toEqual({ value: 42 });
    }
  });
});

describe("rss", () => {
  it("renders a valid document shell with no items", () => {
    const meta: FeedMeta = { title: "Keel Blog", link: "https://keel.dev/blog" };

    const xml = rss(meta, []);

    expect(xml).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(xml).toContain(`<rss version="2.0">`);
    expect(xml).toContain(`<channel>`);
    expect(xml).toContain(`<title>Keel Blog</title>`);
    expect(xml).toContain(`<link>https://keel.dev/blog</link>`);
    expect(xml).toContain(`</channel>`);
    expect(xml).toContain(`</rss>`);

    // An empty feed carries no items.
    expect(xml).not.toContain(`<item>`);
  });

  it("renders every optional channel field when present", () => {
    const meta: FeedMeta = {
      title: "Keel Blog",
      link: "https://keel.dev/blog",
      description: "News from Keel",
      id: "urn:keel:blog",
      updated: "Mon, 08 Jun 2026 00:00:00 GMT",
      author: "ada@keel.dev",
    };

    const xml = rss(meta, []);

    expect(xml).toContain(`<description>News from Keel</description>`);
    expect(xml).toContain(`<guid isPermaLink="false">urn:keel:blog</guid>`);
    expect(xml).toContain(`<managingEditor>ada@keel.dev</managingEditor>`);
    expect(xml).toContain(`<lastBuildDate>Mon, 08 Jun 2026 00:00:00 GMT</lastBuildDate>`);
  });

  it("omits every optional channel field when absent", () => {
    const xml = rss({ title: "Bare", link: "https://keel.dev" }, []);

    expect(xml).not.toContain(`<description>`);
    expect(xml).not.toContain(`<guid`);
    expect(xml).not.toContain(`<managingEditor>`);
    expect(xml).not.toContain(`<lastBuildDate>`);
  });

  it("renders an item with ALL optional fields present", () => {
    const item: FeedItem = {
      title: "Hello",
      link: "https://keel.dev/blog/hello",
      description: "A first post",
      id: "urn:keel:blog:hello",
      published: "Mon, 08 Jun 2026 00:00:00 GMT",
      author: "ada@keel.dev",
    };

    const xml = rss({ title: "Keel Blog", link: "https://keel.dev/blog" }, [item]);

    expect(xml).toContain(`<item>`);
    expect(xml).toContain(`<title>Hello</title>`);
    expect(xml).toContain(`<link>https://keel.dev/blog/hello</link>`);
    expect(xml).toContain(`<description>A first post</description>`);
    expect(xml).toContain(`<guid isPermaLink="false">urn:keel:blog:hello</guid>`);
    expect(xml).toContain(`<author>ada@keel.dev</author>`);
    expect(xml).toContain(`<pubDate>Mon, 08 Jun 2026 00:00:00 GMT</pubDate>`);
    expect(xml).toContain(`</item>`);
  });

  it("renders an item with NO optional fields present", () => {
    const item: FeedItem = { title: "Bare item", link: "https://keel.dev/x" };

    const xml = rss({ title: "Keel Blog", link: "https://keel.dev/blog" }, [item]);

    expect(xml).toContain(`<title>Bare item</title>`);
    expect(xml).toContain(`<link>https://keel.dev/x</link>`);
    expect(xml).not.toContain(`<description>`);
    expect(xml).not.toContain(`<guid`);
    expect(xml).not.toContain(`<author>`);
    expect(xml).not.toContain(`<pubDate>`);
  });

  it("XML-escapes & and < in titles and links", () => {
    const meta: FeedMeta = { title: "Tom & Jerry", link: "https://keel.dev/?a=1&b=2" };
    const item: FeedItem = { title: "1 < 2 & true", link: "https://keel.dev/<x>" };

    const xml = rss(meta, [item]);

    expect(xml).toContain(`<title>Tom &amp; Jerry</title>`);
    expect(xml).toContain(`<link>https://keel.dev/?a=1&amp;b=2</link>`);
    expect(xml).toContain(`<title>1 &lt; 2 &amp; true</title>`);
    expect(xml).toContain(`<link>https://keel.dev/&lt;x&gt;</link>`);

    // The raw, unescaped forms must never appear.
    expect(xml).not.toContain(`Tom & Jerry`);
    expect(xml).not.toContain(`1 < 2`);
  });
});

describe("atom", () => {
  it("renders a valid document shell with no items", () => {
    const meta: FeedMeta = { title: "Keel Blog", link: "https://keel.dev/blog" };

    const xml = atom(meta, []);

    expect(xml).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(xml).toContain(`<feed xmlns="http://www.w3.org/2005/Atom">`);
    expect(xml).toContain(`<title>Keel Blog</title>`);
    expect(xml).toContain(`<link href="https://keel.dev/blog"/>`);
    expect(xml).toContain(`</feed>`);

    expect(xml).not.toContain(`<entry>`);
  });

  it("renders every optional feed field when present", () => {
    const meta: FeedMeta = {
      title: "Keel Blog",
      link: "https://keel.dev/blog",
      description: "News from Keel",
      id: "urn:keel:blog",
      updated: "2026-06-08T00:00:00Z",
      author: "Ada",
    };

    const xml = atom(meta, []);

    expect(xml).toContain(`<id>urn:keel:blog</id>`);
    expect(xml).toContain(`<subtitle>News from Keel</subtitle>`);
    expect(xml).toContain(`<updated>2026-06-08T00:00:00Z</updated>`);
    expect(xml).toContain(`<author><name>Ada</name></author>`);
  });

  it("omits every optional feed field when absent", () => {
    const xml = atom({ title: "Bare", link: "https://keel.dev" }, []);

    expect(xml).not.toContain(`<id>`);
    expect(xml).not.toContain(`<subtitle>`);
    expect(xml).not.toContain(`<updated>`);
    expect(xml).not.toContain(`<author>`);
  });

  it("renders an entry with ALL optional fields present", () => {
    const item: FeedItem = {
      title: "Hello",
      link: "https://keel.dev/blog/hello",
      id: "urn:keel:blog:hello",
      description: "A first post",
      published: "2026-06-08T00:00:00Z",
      author: "Ada",
    };

    const xml = atom({ title: "Keel Blog", link: "https://keel.dev/blog" }, [item]);

    expect(xml).toContain(`<entry>`);
    expect(xml).toContain(`<title>Hello</title>`);
    expect(xml).toContain(`<link href="https://keel.dev/blog/hello"/>`);
    expect(xml).toContain(`<id>urn:keel:blog:hello</id>`);
    expect(xml).toContain(`<summary>A first post</summary>`);
    expect(xml).toContain(`<updated>2026-06-08T00:00:00Z</updated>`);
    expect(xml).toContain(`<author><name>Ada</name></author>`);
    expect(xml).toContain(`</entry>`);
  });

  it("renders an entry with NO optional fields present", () => {
    const item: FeedItem = { title: "Bare item", link: "https://keel.dev/x" };

    const xml = atom({ title: "Keel Blog", link: "https://keel.dev/blog" }, [item]);

    expect(xml).toContain(`<title>Bare item</title>`);
    expect(xml).toContain(`<link href="https://keel.dev/x"/>`);
    expect(xml).not.toContain(`<id>`);
    expect(xml).not.toContain(`<summary>`);
    // No entry-level updated; the feed has no updated either.
    expect(xml).not.toContain(`<updated>`);
  });

  it("XML-escapes & and < in titles and link attributes", () => {
    const meta: FeedMeta = { title: "Tom & Jerry", link: "https://keel.dev/?a=1&b=2" };
    const item: FeedItem = { title: "1 < 2 & true", link: `https://keel.dev/"x"` };

    const xml = atom(meta, [item]);

    expect(xml).toContain(`<title>Tom &amp; Jerry</title>`);
    expect(xml).toContain(`<link href="https://keel.dev/?a=1&amp;b=2"/>`);
    expect(xml).toContain(`<title>1 &lt; 2 &amp; true</title>`);
    expect(xml).toContain(`<link href="https://keel.dev/&quot;x&quot;"/>`);

    expect(xml).not.toContain(`Tom & Jerry`);
    expect(xml).not.toContain(`1 < 2`);
  });
});
