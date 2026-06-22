---
title: "Feeds"
description: "Generate RSS 2.0 and Atom 1.0 syndication feeds with @lesto/feeds — pure, dependency-free XML string builders that escape every value."
section: Batteries
order: 19
---

# Feeds

`@lesto/feeds` turns a channel and a list of items into a syndication feed.
It exports two builders — `rss` for RSS 2.0 and `atom` for Atom 1.0 — that take
the *same* two shapes (`FeedMeta` and `FeedItem`) and differ only in the XML they
emit. They are pure string builders: no dependencies, no I/O, no router coupling.
Each returns a complete XML document as a `string`, and every value that goes into
the document is XML-escaped, so an untrusted post title or query-string link can't
break — or inject into — the output.

The package ships RSS and Atom only. There is **no JSON Feed builder**; if you need
the JSON Feed format, serialize it yourself.

## Build an RSS feed

`rss(meta, items)` takes channel metadata and an array of items, and returns an
RSS 2.0 document. Only `title` and `link` are required on either shape — the rest
are optional and appear only when present:

```ts
import { rss } from "@lesto/feeds";

const xml = rss(
  { title: "Lesto Blog", link: "https://lesto.dev/blog" },
  [
    {
      title: "Hello",
      link: "https://lesto.dev/blog/hello",
      description: "A first post",
      published: new Date("2026-06-08T00:00:00Z"),
    },
  ],
);
```

RSS 2.0 requires the channel to carry a `<description>`. If you don't supply one,
it's synthesized from the `title`, so the document is always spec-valid. A `Date`
in `updated` (channel) or `published` (item) renders as an RFC 822 `<lastBuildDate>` /
`<pubDate>`; the optional `id` becomes a non-permalink `<guid>` and `author`
becomes `<managingEditor>` (channel) / `<author>` (item).

## Build an Atom feed

`atom(meta, items)` takes the identical inputs and returns an Atom 1.0 document:

```ts
import { atom } from "@lesto/feeds";

const xml = atom(
  { title: "Lesto Blog", link: "https://lesto.dev/blog" },
  [{ title: "Hello", link: "https://lesto.dev/blog/hello", published: "2026-06-08T00:00:00Z" }],
);
```

Atom requires an `<id>` and `<updated>` on the feed *and* on every entry. The
builder synthesizes the ones you omit: the feed `<id>` mirrors its `link`; the feed
`<updated>` is your `meta.updated`, else the **first dated entry's** `published`
(feeds are conventionally newest-first, so that is the latest), else now. Each
entry's missing `<id>` comes from its `link`, and its missing `<updated>` inherits
the feed's resolved time. Atom dates render as RFC 3339, and `author` becomes a
nested `<author><name>`. A `description` renders as `<summary>` on an entry, and as
`<subtitle>` on the feed itself.

## Serve a feed from a route

A builder returns a string, so any handler can hand it back as a `Response` with
the right content type. Use `application/rss+xml` for RSS and `application/atom+xml`
for Atom:

```ts
import { rss } from "@lesto/feeds";

export function GET() {
  const xml = rss(
    { title: "Lesto Blog", link: "https://lesto.dev/blog" },
    posts.map((p) => ({
      title: p.title,
      link: `https://lesto.dev/blog/${p.slug}`,
      description: p.excerpt,
      published: p.publishedAt,
    })),
  );

  return new Response(xml, { headers: { "content-type": "application/rss+xml" } });
}
```

Because the builders are pure and synchronous, you can also call them at build time
and write the result to a static file. See [Routing & pages](/guides/routing) for
how handlers return responses.

## Dates and escaping, on their own

The two date formatters and the escaper are exported directly, for when you're
assembling something the builders don't cover (a sitemap, a custom feed extension):

```ts
import { rfc822, rfc3339, escapeXml } from "@lesto/feeds";

rfc822(new Date("2026-06-08T13:04:05Z")); // "Mon, 08 Jun 2026 13:04:05 GMT"
rfc3339(new Date("2026-06-08T13:04:05Z")); // "2026-06-08T13:04:05Z"
escapeXml(`Tom & "Jerry"`); // "Tom &amp; &quot;Jerry&quot;"
```

Both formatters accept a `DateInput` — a `Date`, which they format in UTC, or a
string, which they trust and pass through untouched. `escapeXml` covers the five
predefined XML entities (`&`, `<`, `>`, `"`, `'`) and is safe in both element text
and attribute values.

## Notes and gotchas

- **RSS and Atom only — no JSON Feed.** The package exports `rss` and `atom`. There
  is no JSON Feed builder; build that format by hand if you need it.

- **A pre-formatted date string is trusted as-is.** Pass a `Date` and it's
  formatted in UTC for you (RFC 822 for RSS, RFC 3339 for Atom). Pass a `string`
  and the builder uses it verbatim — so a string in the wrong dialect produces an
  invalid feed silently. Prefer handing the builders a `Date`.

- **The feed `<updated>` is the *first* dated entry, not the newest by scan.** Atom
  resolves the feed time from the first item that has a `published`, on the
  convention that feeds are listed newest-first. If you list oldest-first, set
  `meta.updated` explicitly.

- **An invalid `Date` throws a coded error.** A `Date` whose time is `NaN` raises a
  `FeedError` with code `FEED_INVALID_DATE`; a non-string reaching `escapeXml` raises
  `FEED_UNESCAPABLE_VALUE`. Both extend [`LestoError`](/concepts), so you branch on
  the stable `code`, never the message.

- **Everything is escaped, including links.** Item and channel `link` values pass
  through `escapeXml` too, so an `&` in a query string becomes `&amp;`. The raw,
  unescaped form never appears in the output.

- **`meta.id` is emitted, but RSS treats it as a `<guid>`.** The same `id` field
  becomes the channel/feed `<id>` in Atom and a non-permalink channel `<guid>` in
  RSS. Supply a stable URN if you want consistent identity across both formats.

For validating untrusted input before it reaches a feed, see
[Validation](/guides/validation); for the shared error contract, see
[Concepts](/concepts).
