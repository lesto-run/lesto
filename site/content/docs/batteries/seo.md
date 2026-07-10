---
title: "SEO — meta tags, sitemap, robots, JSON-LD, and OG image builders"
description: "@lesto/seo is a set of zero-dependency, pure string builders for the SEO artifacts a page needs — the &lt;head&gt; meta block, sitemap.xml, robots.txt, a JSON-LD &lt;script&gt;, and an Open Graph card — each escaping or refusing untrusted input before it reaches the output."
section: Batteries
order: 18
---

# SEO

`@lesto/seo` is a set of pure string builders for the five SEO artifacts a page
needs: the `<head>` meta block, `sitemap.xml`, `robots.txt`, a JSON-LD
`<script>`, and an Open Graph preview card. It has no framework dependency and no
runtime state — each function takes plain data and returns a string. The one idea
that runs through all five: every value you pass is untrusted text, so it is
escaped (HTML/XML) or refused (line- and URL-injection) before it reaches the
output. You decide where the strings go — a [route](/guides/routing) handler, a
build step, a layout `<head>`.

## Meta tags

`metaTags` builds the `<title>` and `<meta>` lines for a document head. Only
`title` is required; each absent optional contributes no tag at all, because a
missing tag and an empty `content=""` mean different things to a crawler.

```ts
import { metaTags } from "@lesto/seo";

const head = metaTags({
  title: "Pricing",
  description: "Plans and pricing for the app.",
  canonical: "https://example.com/pricing",
  image: "https://example.com/og/pricing.png",
  type: "website",
});
// <title>Pricing</title>
// <meta property="og:title" content="Pricing" />
// <meta name="description" content="Plans and pricing for the app." />
// <meta property="og:description" content="Plans and pricing for the app." />
// <meta property="og:image" content="https://example.com/og/pricing.png" />
// <meta property="og:type" content="website" />
// <link rel="canonical" href="https://example.com/pricing" />
```

`title` always emits both a `<title>` element and an `og:title` meta. A given
`description` emits both `name="description"` and `og:description`; `image` and
`type` map to `og:image` and `og:type`; `canonical` becomes a `<link rel>`.
Every value is HTML-escaped, so a title of `Tom & Jerry <best>` lands as
`Tom &amp; Jerry &lt;best&gt;` rather than breaking the markup.

## Sitemap

`sitemap` renders a `urlset` XML document from an array of `SitemapUrl` entries.
A relative `loc` is joined to `baseUrl` (on exactly one slash, however either
side is punctuated); an absolute `loc` — one carrying a URL scheme — is left as
written, even when a `baseUrl` is supplied.

```ts
import { sitemap } from "@lesto/seo";

const xml = sitemap(
  [
    { loc: "/", priority: 1.0, lastmod: "2026-06-22" },
    { loc: "/pricing" },
    { loc: "https://blog.example.com/post" }, // absolute — left untouched
  ],
  { baseUrl: "https://example.com" },
);
```

`lastmod` and `priority` emit child elements only when present; absent ones
produce nothing. Every URL is XML-escaped — an `&` in a query string becomes
`&amp;`. The resolved `loc` is also injection-checked (see below), so a value
that smuggles a newline or a `#` fragment is refused rather than written.

## robots.txt

`robots` renders a `robots.txt` body. It always opens with `User-agent: *`,
then one line per `allow`/`disallow` path, then a `Sitemap:` line when given.
Every field is optional; `robots({})` returns the bare, permissive
`User-agent: *`.

```ts
import { robots } from "@lesto/seo";

const txt = robots({
  allow: ["/public"],
  disallow: ["/admin", "/draft"],
  sitemap: "https://example.com/sitemap.xml",
});
// User-agent: *
// Allow: /public
// Disallow: /admin
// Disallow: /draft
// Sitemap: https://example.com/sitemap.xml
```

Each path and the sitemap URL is checked for line injection. A `\r`/`\n` (which
would smuggle a second directive) or a `#` (which opens a comment that truncates
the line) is refused with a coded `SeoError` — never silently written. Gate a
private subtree at the framework boundary too; `robots.txt` is advisory, not
[authorization](/batteries/authz).

## JSON-LD

`jsonLd(type, data)` returns a ready-to-embed `<script type="application/ld+json">`.
It frames your `data` with the two fields every schema.org document needs —
`@context` and `@type` — and serializes with `JSON.stringify`.

```ts
import { jsonLd } from "@lesto/seo";

const script = jsonLd("Article", {
  headline: "How we ship",
  author: { "@type": "Person", name: "Ada" },
  datePublished: "2026-06-22",
});
// <script type="application/ld+json">{"@context":"https://schema.org",
//   "@type":"Article","headline":"How we ship", ...}</script>
```

Every `<` in the serialized JSON is rewritten to the Unicode escape `\u003c`,
so a value containing the literal `</script>` cannot break out of the
surrounding element — the standard hardening for inline JSON in HTML.

## Open Graph image

`ogImage` renders a branded 1200×630 social-preview card as a **self-contained SVG
string** — no raster pipeline, no font loading, no headless browser. Only `title`
is required; a string is one hero line, an array renders one line per entry (lines
after the first take the accent color).

```ts
import { ogImage } from "@lesto/seo";

const svg = ogImage({
  title: ["Batteries included.", "Agent-native."],
  description: "The fullstack framework that ships whole.",
  wordmark: "Lesto",
  footer: "lesto.run",
  colors: { gradientFrom: "#3730a3", gradientTo: "#4f46e5" },
});
```

Serve it from a route or write it to a file, and point `metaTags`' `image` at it.
Every caller-supplied string is HTML-escaped before it reaches the SVG — titles
and descriptions are routinely attacker-influenced. An all-empty `title` is
refused with `SEO_EMPTY_OG_TITLE`. All colors are optional (`OgImageColors`);
omitted fields fall back to the Lesto defaults, so a bare `{ title }` still yields
a complete card. SVG cards render in most modern unfurlers; if you need a raster
everywhere, rasterize this same markup out of band.

## Escaping directly

The same HTML/XML escaper the builders use is exported as `escape`, for the odd
case where you assemble a tag by hand. It encodes the five XML-significant
characters (`&`, `<`, `>`, `"`, `'`), a strict superset of what HTML attributes
need, so one routine serves both surfaces.

```ts
import { escape } from "@lesto/seo";

escape(`Tom & "Jerry" <best>`); // Tom &amp; &quot;Jerry&quot; &lt;best&gt;
```

## Notes and gotchas

- **String builders, not a head manager.** These functions return strings; they
  do not mutate a `<head>`, dedupe tags, or own a render pass. You place the
  output yourself — in a layout, a route handler, or a build step that writes
  `sitemap.xml`/`robots.txt` to disk.
- **`title` is the only required field, and it emits twice.** Every call yields a
  `<title>` and an `og:title`. Each other meta appears only when you pass its
  input, so optional tags are never emitted empty.
- **Injection is refused, not stripped.** `sitemap` and `robots` throw a coded
  `SeoError` (`SEO_INJECTED_NEWLINE` or `SEO_INJECTED_FRAGMENT`) on a `\r`/`\n`
  or `#` in a path/URL, so you learn the input was malformed instead of shipping
  a quietly-mangled file. Branch on the `code`, not the message — like every
  Lesto [error](/concepts), it extends `LestoError`.
- **A sitemap `#` fragment is rejected on purpose.** A fragment has no place in a
  `<loc>`, and the check runs on the *resolved* URL, so a relative `loc` of
  `/page#frag` joined to a `baseUrl` is still refused.
- **`metaTags` escapes; it does not validate.** It will faithfully escape a
  malformed `canonical` or a non-URL `image`. Hand it values you trust to be
  shaped right; use [`@lesto/env`](/batteries/env) or
  [validation](/guides/validation) upstream if those come from outside.
- **JSON-LD trusts your object's shape.** `jsonLd` neutralizes `<` for HTML
  safety but does not check that `type` and `data` form valid schema.org markup —
  that's between you and the spec.

New here? Start with the [quickstart](/quickstart); for where these strings live
in a request, see [routing & pages](/guides/routing). For a fully prerendered
site, [`@lesto/sites`](/batteries/sites)' `defineStaticSite` derives the sitemap
from your route list and emits `sitemap.xml`, `robots.txt`, and the OG card
through these same builders.
