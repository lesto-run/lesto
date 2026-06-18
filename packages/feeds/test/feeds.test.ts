import { describe, expect, it } from "vitest";

import type { FeedItem, FeedMeta } from "../src/types";

import { atom } from "../src/atom";
import { rfc822, rfc3339 } from "../src/dates";
import { FeedError, LestoError } from "../src/errors";
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
      expect(error).toBeInstanceOf(LestoError);
      expect((error as FeedError).code).toBe("FEED_UNESCAPABLE_VALUE");
      expect((error as FeedError).details).toEqual({ value: 42 });
    }
  });
});

describe("date formatting", () => {
  // 2026-06-08T13:04:05.000Z — a Monday.
  const date = new Date(Date.UTC(2026, 5, 8, 13, 4, 5));

  it("formats a Date as an RFC 822 (RSS) UTC timestamp", () => {
    expect(rfc822(date)).toBe("Mon, 08 Jun 2026 13:04:05 GMT");
  });

  it("formats a Date as an RFC 3339 (Atom) UTC timestamp without milliseconds", () => {
    expect(rfc3339(date)).toBe("2026-06-08T13:04:05Z");
  });

  it("passes an already-formatted string through untouched in both dialects", () => {
    expect(rfc822("Mon, 08 Jun 2026 00:00:00 GMT")).toBe("Mon, 08 Jun 2026 00:00:00 GMT");
    expect(rfc3339("2026-06-08T00:00:00Z")).toBe("2026-06-08T00:00:00Z");
  });

  it("refuses an invalid Date with a stable code", () => {
    try {
      rfc822(new Date("not a date"));
      expect.unreachable("rfc822 should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FeedError);
      expect((error as FeedError).code).toBe("FEED_INVALID_DATE");
    }
  });
});

describe("rss", () => {
  it("renders a valid document shell with no items", () => {
    const meta: FeedMeta = { title: "Lesto Blog", link: "https://lesto.dev/blog" };

    const xml = rss(meta, []);

    expect(xml).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(xml).toContain(`<rss version="2.0">`);
    expect(xml).toContain(`<channel>`);
    expect(xml).toContain(`<title>Lesto Blog</title>`);
    expect(xml).toContain(`<link>https://lesto.dev/blog</link>`);
    expect(xml).toContain(`</channel>`);
    expect(xml).toContain(`</rss>`);

    // An empty feed carries no items.
    expect(xml).not.toContain(`<item>`);
  });

  it("synthesizes the required channel <description> from the title", () => {
    // RSS 2.0 requires <description>; absent one, it mirrors the title.
    const xml = rss({ title: "Lesto Blog", link: "https://lesto.dev/blog" }, []);

    expect(xml).toContain(`<description>Lesto Blog</description>`);
  });

  it("renders every optional channel field when present", () => {
    const meta: FeedMeta = {
      title: "Lesto Blog",
      link: "https://lesto.dev/blog",
      description: "News from Lesto",
      id: "urn:lesto:blog",
      updated: "Mon, 08 Jun 2026 00:00:00 GMT",
      author: "ada@lesto.dev",
    };

    const xml = rss(meta, []);

    expect(xml).toContain(`<description>News from Lesto</description>`);
    expect(xml).toContain(`<guid isPermaLink="false">urn:lesto:blog</guid>`);
    expect(xml).toContain(`<managingEditor>ada@lesto.dev</managingEditor>`);
    expect(xml).toContain(`<lastBuildDate>Mon, 08 Jun 2026 00:00:00 GMT</lastBuildDate>`);
  });

  it("formats a Date <lastBuildDate> as RFC 822", () => {
    const xml = rss(
      {
        title: "Lesto Blog",
        link: "https://lesto.dev/blog",
        updated: new Date(Date.UTC(2026, 5, 8, 0, 0, 0)),
      },
      [],
    );

    expect(xml).toContain(`<lastBuildDate>Mon, 08 Jun 2026 00:00:00 GMT</lastBuildDate>`);
  });

  it("omits the optional channel fields (but never the required description) when absent", () => {
    const xml = rss({ title: "Bare", link: "https://lesto.dev" }, []);

    expect(xml).toContain(`<description>Bare</description>`);
    expect(xml).not.toContain(`<guid`);
    expect(xml).not.toContain(`<managingEditor>`);
    expect(xml).not.toContain(`<lastBuildDate>`);
  });

  it("renders an item with ALL optional fields present", () => {
    const item: FeedItem = {
      title: "Hello",
      link: "https://lesto.dev/blog/hello",
      description: "A first post",
      id: "urn:lesto:blog:hello",
      published: "Mon, 08 Jun 2026 00:00:00 GMT",
      author: "ada@lesto.dev",
    };

    const xml = rss({ title: "Lesto Blog", link: "https://lesto.dev/blog" }, [item]);

    expect(xml).toContain(`<item>`);
    expect(xml).toContain(`<title>Hello</title>`);
    expect(xml).toContain(`<link>https://lesto.dev/blog/hello</link>`);
    expect(xml).toContain(`<description>A first post</description>`);
    expect(xml).toContain(`<guid isPermaLink="false">urn:lesto:blog:hello</guid>`);
    expect(xml).toContain(`<author>ada@lesto.dev</author>`);
    expect(xml).toContain(`<pubDate>Mon, 08 Jun 2026 00:00:00 GMT</pubDate>`);
    expect(xml).toContain(`</item>`);
  });

  it("formats a Date item <pubDate> as RFC 822", () => {
    const item: FeedItem = {
      title: "Hello",
      link: "https://lesto.dev/blog/hello",
      published: new Date(Date.UTC(2026, 5, 8, 0, 0, 0)),
    };

    const xml = rss({ title: "Lesto Blog", link: "https://lesto.dev/blog" }, [item]);

    expect(xml).toContain(`<pubDate>Mon, 08 Jun 2026 00:00:00 GMT</pubDate>`);
  });

  it("renders an item with NO optional fields present", () => {
    const item: FeedItem = { title: "Bare item", link: "https://lesto.dev/x" };

    const xml = rss({ title: "Lesto Blog", link: "https://lesto.dev/blog" }, [item]);

    expect(xml).toContain(`<title>Bare item</title>`);
    expect(xml).toContain(`<link>https://lesto.dev/x</link>`);
    // The item carries no description of its own.
    expect(xml).not.toContain(`<description>A first post</description>`);
    expect(xml).not.toContain(`<guid`);
    expect(xml).not.toContain(`<author>`);
    expect(xml).not.toContain(`<pubDate>`);
  });

  it("XML-escapes & and < in titles and links", () => {
    const meta: FeedMeta = { title: "Tom & Jerry", link: "https://lesto.dev/?a=1&b=2" };
    const item: FeedItem = { title: "1 < 2 & true", link: "https://lesto.dev/<x>" };

    const xml = rss(meta, [item]);

    expect(xml).toContain(`<title>Tom &amp; Jerry</title>`);
    expect(xml).toContain(`<link>https://lesto.dev/?a=1&amp;b=2</link>`);
    expect(xml).toContain(`<title>1 &lt; 2 &amp; true</title>`);
    expect(xml).toContain(`<link>https://lesto.dev/&lt;x&gt;</link>`);

    // The raw, unescaped forms must never appear.
    expect(xml).not.toContain(`Tom & Jerry`);
    expect(xml).not.toContain(`1 < 2`);
  });
});

describe("atom", () => {
  it("renders a valid document shell with no items", () => {
    const meta: FeedMeta = { title: "Lesto Blog", link: "https://lesto.dev/blog" };

    const xml = atom(meta, []);

    expect(xml).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(xml).toContain(`<feed xmlns="http://www.w3.org/2005/Atom">`);
    expect(xml).toContain(`<title>Lesto Blog</title>`);
    expect(xml).toContain(`<link href="https://lesto.dev/blog"/>`);
    expect(xml).toContain(`</feed>`);

    expect(xml).not.toContain(`<entry>`);
  });

  it("synthesizes the required feed <id> from the link and an RFC 3339 <updated>", () => {
    // Atom 1.0 requires <id> and <updated>; absent input, id mirrors the link
    // and updated falls back to now (a valid RFC 3339 instant).
    const xml = atom({ title: "Lesto Blog", link: "https://lesto.dev/blog" }, []);

    expect(xml).toContain(`<id>https://lesto.dev/blog</id>`);
    expect(xml).toMatch(/<updated>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/updated>/);
  });

  it("renders every optional feed field when present", () => {
    const meta: FeedMeta = {
      title: "Lesto Blog",
      link: "https://lesto.dev/blog",
      description: "News from Lesto",
      id: "urn:lesto:blog",
      updated: "2026-06-08T00:00:00Z",
      author: "Ada",
    };

    const xml = atom(meta, []);

    expect(xml).toContain(`<id>urn:lesto:blog</id>`);
    expect(xml).toContain(`<subtitle>News from Lesto</subtitle>`);
    expect(xml).toContain(`<updated>2026-06-08T00:00:00Z</updated>`);
    expect(xml).toContain(`<author><name>Ada</name></author>`);
  });

  it("formats a Date feed <updated> as RFC 3339", () => {
    const xml = atom(
      {
        title: "Lesto Blog",
        link: "https://lesto.dev/blog",
        updated: new Date(Date.UTC(2026, 5, 8, 0, 0, 0)),
      },
      [],
    );

    expect(xml).toContain(`<updated>2026-06-08T00:00:00Z</updated>`);
  });

  it("falls the feed <updated> back to the first dated entry's published date", () => {
    const item: FeedItem = {
      title: "Hello",
      link: "https://lesto.dev/blog/hello",
      published: "2026-06-08T00:00:00Z",
    };

    const xml = atom({ title: "Lesto Blog", link: "https://lesto.dev/blog" }, [item]);

    expect(xml).toContain(`<updated>2026-06-08T00:00:00Z</updated>`);
  });

  it("uses the FIRST dated entry for the feed <updated>, not a later entry's date", () => {
    // The contract is "first dated entry" (feeds are listed newest-first), not a
    // max-date scan: the later "Older" date must not become the feed time.
    const items: FeedItem[] = [
      { title: "Newer", link: "https://lesto.dev/blog/newer", published: "2026-06-08T00:00:00Z" },
      { title: "Older", link: "https://lesto.dev/blog/older", published: "2026-01-01T00:00:00Z" },
    ];

    const xml = atom({ title: "Lesto Blog", link: "https://lesto.dev/blog" }, items);

    // The feed-level fields are everything before the first <entry>.
    const head = xml.slice(0, xml.indexOf("<entry>"));

    expect(head).toContain(`<updated>2026-06-08T00:00:00Z</updated>`);
    expect(head).not.toContain("2026-01-01");
    // The older entry still carries its own date.
    expect(xml).toContain(`<updated>2026-01-01T00:00:00Z</updated>`);
  });

  it("omits the optional feed fields (but never the required id/updated) when absent", () => {
    const xml = atom({ title: "Bare", link: "https://lesto.dev" }, []);

    expect(xml).toContain(`<id>https://lesto.dev</id>`);
    expect(xml).toContain(`<updated>`);
    expect(xml).not.toContain(`<subtitle>`);
    expect(xml).not.toContain(`<author>`);
  });

  it("renders an entry with ALL optional fields present", () => {
    const item: FeedItem = {
      title: "Hello",
      link: "https://lesto.dev/blog/hello",
      id: "urn:lesto:blog:hello",
      description: "A first post",
      published: "2026-06-08T00:00:00Z",
      author: "Ada",
    };

    const xml = atom({ title: "Lesto Blog", link: "https://lesto.dev/blog" }, [item]);

    expect(xml).toContain(`<entry>`);
    expect(xml).toContain(`<title>Hello</title>`);
    expect(xml).toContain(`<link href="https://lesto.dev/blog/hello"/>`);
    expect(xml).toContain(`<id>urn:lesto:blog:hello</id>`);
    expect(xml).toContain(`<summary>A first post</summary>`);
    expect(xml).toContain(`<updated>2026-06-08T00:00:00Z</updated>`);
    expect(xml).toContain(`<author><name>Ada</name></author>`);
    expect(xml).toContain(`</entry>`);
  });

  it("formats a Date entry <updated> as RFC 3339", () => {
    const item: FeedItem = {
      title: "Hello",
      link: "https://lesto.dev/blog/hello",
      published: new Date(Date.UTC(2026, 5, 8, 0, 0, 0)),
    };

    const xml = atom({ title: "Lesto Blog", link: "https://lesto.dev/blog" }, [item]);

    expect(xml).toContain(`<updated>2026-06-08T00:00:00Z</updated>`);
  });

  it("synthesizes a missing entry id and updated from the link and the feed time", () => {
    const item: FeedItem = { title: "Bare item", link: "https://lesto.dev/x" };

    const xml = atom(
      { title: "Lesto Blog", link: "https://lesto.dev/blog", updated: "2026-06-08T00:00:00Z" },
      [item],
    );

    // Entry <id> mirrors its link; entry <updated> inherits the feed's time.
    expect(xml).toContain(`<id>https://lesto.dev/x</id>`);
    // Two <updated> instances (feed + entry), both the resolved feed time.
    expect(xml.match(/<updated>2026-06-08T00:00:00Z<\/updated>/g)).toHaveLength(2);
    expect(xml).not.toContain(`<summary>`);
  });

  it("XML-escapes & and < in titles and link attributes", () => {
    const meta: FeedMeta = { title: "Tom & Jerry", link: "https://lesto.dev/?a=1&b=2" };
    const item: FeedItem = { title: "1 < 2 & true", link: `https://lesto.dev/"x"` };

    const xml = atom(meta, [item]);

    expect(xml).toContain(`<title>Tom &amp; Jerry</title>`);
    expect(xml).toContain(`<link href="https://lesto.dev/?a=1&amp;b=2"/>`);
    expect(xml).toContain(`<title>1 &lt; 2 &amp; true</title>`);
    expect(xml).toContain(`<link href="https://lesto.dev/&quot;x&quot;"/>`);

    expect(xml).not.toContain(`Tom & Jerry`);
    expect(xml).not.toContain(`1 < 2`);
  });
});
