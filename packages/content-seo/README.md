# @keel/content-seo

Content-aware SEO for Keel: analysis (score, keyword density, recommendations)
and **entry-aware** JSON-LD generation that reads a content record and emits the
right Schema.org type.

## Relationship to `@keel/seo`

These two are deliberately separate, at different layers — keep both:

- [`@keel/seo`](../seo) is the **zero-dependency primitive layer**: `metaTags`,
  `sitemap`, `robots`, `escape`, and a low-level `jsonLd(type, data)` that wraps
  an object you build yourself. Use it anywhere, content system or not.
- `@keel/content-seo` is the **content-aware layer** (depends on
  `@keel/content-shared`): it analyzes markdown and turns a content *entry* into
  structured data via `jsonLd.article(entry)`, `jsonLd.blogPost(entry)`, `.graph(...)`,
  etc. Its `jsonLd.create(type, data)` is the equivalent of `@keel/seo`'s
  low-level `jsonLd` when you need to hand-build a type.

Rule of thumb: building primitives by hand → `@keel/seo`; turning content
records into SEO → `@keel/content-seo`. They do not duplicate each other.

## Quick Start

```typescript
import { analyzeSEO, jsonLd } from "@keel/content-seo";

// Analyze content SEO
const analysis = analyzeSEO({
  title: "Getting Started",
  description: "Learn how to use Docks",
  content: markdownContent,
});

console.log(analysis.score); // 0-100
console.log(analysis.issues); // Array of issues

// Generate JSON-LD
const schema = jsonLd.article({
  title: "Getting Started",
  author: "Jane Doe",
  publishedAt: new Date(),
});
```

## Features

- **SEO scoring** - Score content 0-100
- **Issue detection** - Find SEO problems
- **JSON-LD generation** - Schema.org markup
- **Meta tag helpers** - Generate meta tags

## Schema Types

```typescript
jsonLd.article({ ... })
jsonLd.blogPosting({ ... })
jsonLd.organization({ ... })
jsonLd.breadcrumb({ ... })
```

## Documentation

Full documentation at [usedocks.dev](https://usedocks.dev)

## License

MIT
